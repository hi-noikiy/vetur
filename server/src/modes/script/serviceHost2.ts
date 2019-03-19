import * as path from 'path';
import Uri from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-types';
import * as parseGitIgnore from 'parse-gitignore';

import { LanguageModelCache } from '../languageModelCache';
import { parseVue, isVue, createUpdater } from './preprocess';
import * as bridge from './bridge';
import {
  LanguageServiceHost,
  CompilerOptions,
  ScriptTarget,
  ModuleResolutionKind,
  ModuleKind,
  JsxEmit,
  System,
  ResolvedModule,
  IScriptSnapshot,
  ScriptKind
} from 'typescript';
import { T_TypeScript } from '../../services/dependencyService';
import { getFileFsPath, getFilePath } from '../../utils/paths';

/**
 * A Language Service host that manages .vue files
 */
export class VueTSLanguageServiceHost implements LanguageServiceHost {
  private workspacePath: string;
  private tsModule: T_TypeScript;
  private vueSys: System;

  private currentScriptDoc: TextDocument;

  private compilerOptions: CompilerOptions = {
    allowNonTsExtensions: true,
    allowJs: true,
    lib: ['lib.dom.d.ts', 'lib.es2017.d.ts'],
    target: ScriptTarget.Latest,
    moduleResolution: ModuleResolutionKind.NodeJs,
    module: ModuleKind.CommonJS,
    jsx: JsxEmit.Preserve,
    allowSyntheticDefaultImports: true
  };

  private scriptFileNames: string[] = [];

  private versions: Map<string, number> = new Map();
  private scriptDocs: Map<string, TextDocument> = new Map();

  /**
   * Is using Vue < 2.5 where typing is bad
   */
  private isOldVersion = false;

  constructor(private jsDocuments: LanguageModelCache<TextDocument>) {}

  /**
   * Init
   */

  patchTS() {
    // Patch typescript functions to insert `import Vue from 'vue'` and `new Vue` around export default.
    // NOTE: this is a global hack that all ts instances after is changed
    const { createLanguageServiceSourceFile, updateLanguageServiceSourceFile } = createUpdater(this.tsModule);
    (this.tsModule as any).createLanguageServiceSourceFile = createLanguageServiceSourceFile;
    (this.tsModule as any).updateLanguageServiceSourceFile = updateLanguageServiceSourceFile;
  }

  async init(workspacePath: string, tsModule: T_TypeScript) {
    this.workspacePath = workspacePath;
    this.tsModule = tsModule;

    this.patchTS();

    const parsedConfig = getParsedConfig(tsModule, workspacePath);

    this.scriptFileNames = parsedConfig.fileNames;
    this.compilerOptions = {
      ...this.compilerOptions,
      ...parsedConfig.options,
      ...{ allowNonTsExtensions: true }
    };

    this.isOldVersion = inferIsOldVersion(tsModule, workspacePath);

    this.vueSys = getVueSys(tsModule);
  }

  inferIsOldVersion(workspacePath: string) {
    const packageJSONPath = this.tsModule.findConfigFile(workspacePath, this.tsModule.sys.fileExists, 'package.json');
    try {
      const packageJSON = packageJSONPath && JSON.parse(this.tsModule.sys.readFile(packageJSONPath)!);
      const vueStr = packageJSON.dependencies.vue || packageJSON.devDependencies.vue;
      // use a sloppy method to infer version, to reduce dep on semver or so
      const vueDep = vueStr.match(/\d+\.\d+/)[0];
      const sloppyVersion = parseFloat(vueDep);
      return sloppyVersion < 2.5;
    } catch (e) {
      return true;
    }
  }

  /**
   * ts.LanguageServiceHost API Begin
   */

  getCompilationSettings() {
    return this.compilerOptions;
  }

  // A list of absolute file paths that's handled by TS Server
  getScriptFileNames() {
    return this.scriptFileNames;
  }

  getScriptVersion(fileName: string) {
    if (fileName === bridge.fileName) {
      return '0';
    }

    const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
    const version = this.versions.get(normalizedFileFsPath);
    return version ? version.toString() : '0';
  }

  getScriptKind(fileName: string) {
    if (isVue(fileName)) {
      const uri = Uri.file(fileName);
      fileName = uri.fsPath;
      const doc =
        this.scriptDocs.get(fileName) ||
        this.jsDocuments.get(TextDocument.create(uri.toString(), 'vue', 0, this.tsModule.sys.readFile(fileName) || ''));
      return getScriptKind(this.tsModule, doc.languageId);
    } else {
      if (fileName === bridge.fileName) {
        return this.tsModule.Extension.Ts;
      }
      // Note: Typescript 2.3 should export getScriptKindFromFileName. Then this cast should be removed.
      // But as of TS 3.3 this still hasn't been exposed.
      return (this.tsModule as any).getScriptKindFromFileName(fileName);
    }
  }

  resolveModuleNames(moduleNames: string[], containingFile: string): ResolvedModule[] {
    // in the normal case, delegate to ts.resolveModuleName
    // in the relative-imported.vue case, manually build a resolved filename
    return moduleNames.map(name => {
      if (name === bridge.moduleName) {
        return {
          resolvedFileName: bridge.fileName,
          extension: this.tsModule.Extension.Ts
        };
      }
      if (path.isAbsolute(name) || !isVue(name)) {
        return this.tsModule.resolveModuleName(name, containingFile, this.compilerOptions, this.tsModule.sys)
          .resolvedModule;
      }
      const resolved = this.tsModule.resolveModuleName(name, containingFile, this.compilerOptions, this.vueSys)
        .resolvedModule;
      if (!resolved) {
        return undefined as any;
      }
      if (!resolved.resolvedFileName.endsWith('.vue.ts')) {
        return resolved;
      }
      const resolvedFileName = resolved.resolvedFileName.slice(0, -3);
      const uri = Uri.file(resolvedFileName);
      const doc =
        this.scriptDocs.get(resolvedFileName) ||
        this.jsDocuments.get(
          TextDocument.create(uri.toString(), 'vue', 0, this.tsModule.sys.readFile(resolvedFileName) || '')
        );
      const extension =
        doc.languageId === 'typescript'
          ? this.tsModule.Extension.Ts
          : doc.languageId === 'tsx'
          ? this.tsModule.Extension.Tsx
          : this.tsModule.Extension.Js;
      return { resolvedFileName, extension };
    });
  }

  getScriptSnapshot(fileName: string): IScriptSnapshot {
    if (fileName === bridge.fileName) {
      const text = this.isOldVersion ? bridge.oldContent : bridge.content;
      return {
        getText: (start, end) => text.substring(start, end),
        getLength: () => text.length,
        getChangeRange: () => void 0
      };
    }
    const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
    const doc = this.scriptDocs.get(normalizedFileFsPath);
    let fileText = doc ? doc.getText() : this.tsModule.sys.readFile(normalizedFileFsPath) || '';
    if (!doc && isVue(fileName)) {
      // Note: This is required in addition to the parsing in embeddedSupport because
      // this works for .vue files that aren't even loaded by VS Code yet.
      fileText = parseVue(fileText);
    }
    return {
      getText: (start, end) => fileText.substring(start, end),
      getLength: () => fileText.length,
      getChangeRange: () => void 0
    };
  }

  readFile(fileName: string): string | undefined {
    return this.vueSys.readFile(fileName);
  }
  fileExists(fileName: string): boolean {
    return this.vueSys.fileExists(fileName);
  }
  directoryExists(directoryName: string): boolean {
    return this.vueSys.directoryExists(directoryName);
  }
  getDirectories(path: string): string[] {
    return this.vueSys.getDirectories(path);
  }
  readDirectory(
    path: string,
    extensions?: ReadonlyArray<string>,
    exclude?: ReadonlyArray<string>,
    include?: ReadonlyArray<string>,
    depth?: number
  ): string[] {
    return this.vueSys.readDirectory(path, extensions, exclude, include, depth);
  }

  getCurrentDirectory() {
    return this.workspacePath;
  }

  getDefaultLibFileName(options: CompilerOptions) {
    return this.tsModule.getDefaultLibFileName(options);
  }

  getNewLine: () => '\n';

  /**
   * ts.LanguageServiceHost API End
   */

  /**
   * Get latest scriptDoc that correspond to the Vue doc
   *
   * @param doc The Vue document that contains full <template>, <style> and <script> sections
   * @returns The matching scriptDoc where non-<script> parts are replaced with whitespaces
   */

  getCorrespondingScriptDocument(doc: TextDocument): TextDocument {
    const fileFsPath = getFileFsPath(doc.uri);
    const filePath = getFilePath(doc.uri);
    // When file is not in language service, add it
    if (!this.scriptDocs.has(fileFsPath)) {
      if (fileFsPath.endsWith('.vue')) {
        this.scriptFileNames.push(filePath);
      }
    }
    if (
      !this.currentScriptDoc ||
      doc.uri !== this.currentScriptDoc.uri ||
      doc.version !== this.currentScriptDoc.version
    ) {
      this.currentScriptDoc = this.jsDocuments.get(doc);
      const lastDoc = this.scriptDocs.get(fileFsPath);
      if (lastDoc && this.currentScriptDoc.languageId !== lastDoc.languageId) {
        // if languageId changed, restart the language service; it can't handle file type changes
        // @Todo: Bring back JS language service restart
        // this.jsLanguageService.dispose();
        // this.jsLanguageService = this.tsModule.createLanguageService(host);
      }
      this.scriptDocs.set(fileFsPath, this.currentScriptDoc);
      this.versions.set(fileFsPath, (this.versions.get(fileFsPath) || 0) + 1);
    }

    return this.currentScriptDoc;
  }

  updateExternalDocument(filePath: string) {
    const ver = this.versions.get(filePath) || 0;
    this.versions.set(filePath, ver + 1);
  }
}

function getVueSys(tsModule: T_TypeScript) {
  const vueSys: System = {
    ...tsModule.sys,
    fileExists(path: string) {
      if (isVueProject(path)) {
        return tsModule.sys.fileExists(path.slice(0, -3));
      }
      return tsModule.sys.fileExists(path);
    },
    readFile(path, encoding) {
      if (isVueProject(path)) {
        const fileText = tsModule.sys.readFile(path.slice(0, -3), encoding);
        return fileText ? parseVue(fileText) : fileText;
      } else {
        const fileText = tsModule.sys.readFile(path, encoding);
        return fileText;
      }
    }
  };

  if (tsModule.sys.realpath) {
    const realpath = tsModule.sys.realpath;
    vueSys.realpath = function(path) {
      if (isVueProject(path)) {
        return realpath(path.slice(0, -3)) + '.ts';
      }
      return realpath(path);
    };
  }

  return vueSys;
}

function getNormalizedFileFsPath(fileName: string): string {
  return Uri.file(fileName).fsPath;
}

function isVueProject(path: string) {
  return path.endsWith('.vue.ts') && !path.includes('node_modules');
}

function defaultIgnorePatterns(tsModule: T_TypeScript, workspacePath: string) {
  const nodeModules = ['node_modules', '**/node_modules/*'];
  const gitignore = tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, '.gitignore');
  if (!gitignore) {
    return nodeModules;
  }
  const parsed: string[] = parseGitIgnore(gitignore);
  const filtered = parsed.filter(s => !s.startsWith('!'));
  return nodeModules.concat(filtered);
}

function getScriptKind(tsModule: T_TypeScript, langId: string): ScriptKind {
  return langId === 'typescript'
    ? tsModule.ScriptKind.TS
    : langId === 'tsx'
    ? tsModule.ScriptKind.TSX
    : tsModule.ScriptKind.JS;
}

function inferIsOldVersion(tsModule: T_TypeScript, workspacePath: string): boolean {
  const packageJSONPath = tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, 'package.json');
  try {
    const packageJSON = packageJSONPath && JSON.parse(tsModule.sys.readFile(packageJSONPath)!);
    const vueStr = packageJSON.dependencies.vue || packageJSON.devDependencies.vue;
    // use a sloppy method to infer version, to reduce dep on semver or so
    const vueDep = vueStr.match(/\d+\.\d+/)[0];
    const sloppyVersion = parseFloat(vueDep);
    return sloppyVersion < 2.5;
  } catch (e) {
    return true;
  }
}

function getParsedConfig(tsModule: T_TypeScript, workspacePath: string) {
  const configFilename =
    tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, 'tsconfig.json') ||
    tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, 'jsconfig.json');
  const configJson = (configFilename && tsModule.readConfigFile(configFilename, tsModule.sys.readFile).config) || {
    exclude: defaultIgnorePatterns(tsModule, workspacePath)
  };
  // existingOptions should be empty since it always takes priority
  return tsModule.parseJsonConfigFileContent(
    configJson,
    tsModule.sys,
    workspacePath,
    /*existingOptions*/ {},
    configFilename,
    /*resolutionStack*/ undefined,
    [{ extension: 'vue', isMixedContent: true }]
  );
}
