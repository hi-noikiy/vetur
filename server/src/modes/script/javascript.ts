import { LanguageModelCache, getLanguageModelCache } from '../languageModelCache';
import {
  SymbolInformation,
  SymbolKind,
  CompletionItem,
  Location,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  Definition,
  TextEdit,
  TextDocument,
  Diagnostic,
  DiagnosticSeverity,
  Range,
  CompletionItemKind,
  Hover,
  MarkedString,
  DocumentHighlight,
  DocumentHighlightKind,
  CompletionList,
  Position,
  FormattingOptions
} from 'vscode-languageserver-types';
import { ILanguageMode, VLSServices } from '../languageModes';
import { VueDocumentRegions, LanguageRange } from '../embeddedSupport';
import { prettierify, prettierEslintify } from '../../utils/prettier';
import { getFileFsPath, getFilePath } from '../../utils/paths';

import Uri from 'vscode-uri';
// import * as ts from 'typescript';
import {
  TextSpan,
  NavigationBarItem,
  FormatCodeSettings,
  Program,
  LanguageService,
  ScriptElementKind,
  CodeAction,
  LanguageServiceHost
} from 'typescript';
import * as _ from 'lodash';

import { NULL_SIGNATURE } from '../nullMode';
import { VLSFormatConfig } from '../../config';
import { VueInfoService } from '../../services/vueInfoService';
import { getComponentInfo } from './componentInfo';
import { State, T_TypeScript } from '../../services/dependencyService';
import { VueTSLanguageServiceHost } from './serviceHost2';
import { getServiceHost } from './serviceHost';

// Todo: After upgrading to LS server 4.0, use CompletionContext for filtering trigger chars
// https://microsoft.github.io/language-server-protocol/specification#completion-request-leftwards_arrow_with_hook
const NON_SCRIPT_TRIGGERS = ['<', '/', '*', ':'];

export class JavaScriptMode implements ILanguageMode {
  private tsModule: T_TypeScript;
  private tsLanguageServiceHost: VueTSLanguageServiceHost | LanguageServiceHost;
  private tsLanguageService: LanguageService;
  private vueInfoService: VueInfoService | undefined;

  private jsDocuments: LanguageModelCache<TextDocument>;
  //@Todo: Remove this
  private regionStart: LanguageModelCache<LanguageRange | undefined>;

  private config: any = {};

  //@Todo: Remove this
  private updateCurrentTextDocument: any;
  private updateExternalDocument: any;

  constructor(private documentRegions: LanguageModelCache<VueDocumentRegions>) {}

  async init(workspacePath: string, services: VLSServices) {
    this.initServices(services);

    const jsDocuments = getLanguageModelCache(10, 60, document => {
      const vueDocument = this.documentRegions.get(document);
      return vueDocument.getEmbeddedDocumentByType('script');
    });
    this.jsDocuments = jsDocuments;

    const regionStart = getLanguageModelCache(10, 60, document => {
      const vueDocument = this.documentRegions.get(document);
      return vueDocument.getLanguageRangeByType('script');
    });
    this.regionStart = regionStart;

    // this.tsLanguageServiceHost = new VueTSLanguageServiceHost(jsDocuments);
    const { host, updateCurrentTextDocument, updateExternalDocument } = getServiceHost(workspacePath, jsDocuments);
    this.tsLanguageServiceHost = host;
    this.updateCurrentTextDocument = updateCurrentTextDocument;
    this.updateExternalDocument = updateExternalDocument;
    // await this.tsLanguageServiceHost.init(workspacePath, this.tsModule);
    this.tsLanguageService = this.tsModule.createLanguageService(this.tsLanguageServiceHost);
  }

  private initServices(services: VLSServices) {
    if (services.infoService) {
      this.vueInfoService = services.infoService;
    }
    if (services.dependencyService) {
      const tsModule = services.dependencyService.getDependency('typescript');
      if (tsModule && tsModule.state === State.Loaded) {
        this.tsModule = tsModule.module as T_TypeScript;
      }
    }
  }

  getId() {
    return 'javascript';
  }

  configure(c: any) {
    this.config = c;
  }

  updateFileInfo(doc: TextDocument): void {
    if (!this.vueInfoService) {
      return;
    }

    this.updateCurrentTextDocument(doc);
    const fileFsPath = getFileFsPath(doc.uri);
    const info = getComponentInfo(this.tsLanguageService, fileFsPath, this.config);
    if (info) {
      this.vueInfoService.updateInfo(doc, info);
    }
  }

  /**
   * LSP section begin
   */

  doValidation(doc: TextDocument): Diagnostic[] {
    const { scriptDoc } = this.updateCurrentTextDocument(doc);

    if (!languageServiceIncludesFile(this.tsLanguageService, doc.uri)) {
      return [];
    }

    const fileFsPath = getFileFsPath(doc.uri);
    const diagnostics = [
      ...this.tsLanguageService.getSyntacticDiagnostics(fileFsPath),
      ...this.tsLanguageService.getSemanticDiagnostics(fileFsPath)
    ];

    return diagnostics.map(diag => {
      // syntactic/semantic diagnostic always has start and length
      // so we can safely cast diag to TextSpan
      return {
        range: convertRange(scriptDoc, diag as TextSpan),
        severity: DiagnosticSeverity.Error,
        message: this.tsModule.flattenDiagnosticMessageText(diag.messageText, '\n')
      };
    });
  }

  doComplete(doc: TextDocument, position: Position): CompletionList {
    const { scriptDoc } = this.updateCurrentTextDocument(doc);

    if (!languageServiceIncludesFile(this.tsLanguageService, doc.uri)) {
      return { isIncomplete: false, items: [] };
    }

    const fileFsPath = getFileFsPath(doc.uri);
    const offset = scriptDoc.offsetAt(position);
    const triggerChar = doc.getText()[offset - 1];
    if (NON_SCRIPT_TRIGGERS.includes(triggerChar)) {
      return { isIncomplete: false, items: [] };
    }
    const completions = this.tsLanguageService.getCompletionsAtPosition(fileFsPath, offset, {
      includeExternalModuleExports: _.get(this.config, ['vetur', 'completion', 'autoImport']),
      includeInsertTextCompletions: false
    });
    if (!completions) {
      return { isIncomplete: false, items: [] };
    }
    const entries = completions.entries.filter(entry => entry.name !== '__vueEditorBridge');
    return {
      isIncomplete: false,
      items: entries.map((entry, index) => {
        const range = entry.replacementSpan && convertRange(scriptDoc, entry.replacementSpan);
        return {
          uri: doc.uri,
          position,
          label: entry.name,
          sortText: entry.sortText + index,
          kind: convertKind(entry.kind),
          textEdit: range && TextEdit.replace(range, entry.name),
          data: {
            // data used for resolving item details (see 'doResolve')
            languageId: scriptDoc.languageId,
            uri: doc.uri,
            offset,
            source: entry.source
          }
        };
      })
    };
  }
  doResolve(doc: TextDocument, item: CompletionItem): CompletionItem {
    if (!languageServiceIncludesFile(this.tsLanguageService, doc.uri)) {
      return item;
    }

    const fileFsPath = getFileFsPath(doc.uri);
    const details = this.tsLanguageService.getCompletionEntryDetails(
      fileFsPath,
      item.data.offset,
      item.label,
      /*formattingOption*/ {},
      item.data.source
    );
    if (details) {
      item.detail = this.tsModule.displayPartsToString(details.displayParts);
      item.documentation = this.tsModule.displayPartsToString(details.documentation);
      if (details.codeActions && this.config.vetur.completion.autoImport) {
        const textEdits = convertCodeAction(doc, details.codeActions, this.regionStart);
        item.additionalTextEdits = textEdits;
      }
      delete item.data;
    }
    return item;
  }
  doHover(doc: TextDocument, position: Position): Hover {
    const { scriptDoc } = this.updateCurrentTextDocument(doc);
    if (!languageServiceIncludesFile(this.tsLanguageService, doc.uri)) {
      return { contents: [] };
    }

    const fileFsPath = getFileFsPath(doc.uri);
    const info = this.tsLanguageService.getQuickInfoAtPosition(fileFsPath, scriptDoc.offsetAt(position));
    if (info) {
      const display = this.tsModule.displayPartsToString(info.displayParts);
      const doc = this.tsModule.displayPartsToString(info.documentation);
      const markedContents: MarkedString[] = [{ language: 'ts', value: display }];
      if (doc) {
        markedContents.unshift(doc, '\n');
      }
      return {
        range: convertRange(scriptDoc, info.textSpan),
        contents: markedContents
      };
    }
    return { contents: [] };
  }
  doSignatureHelp(doc: TextDocument, position: Position): SignatureHelp | null {
    const { scriptDoc } = this.updateCurrentTextDocument(doc);
    if (!languageServiceIncludesFile(this.tsLanguageService, doc.uri)) {
      return NULL_SIGNATURE;
    }

    const fileFsPath = getFileFsPath(doc.uri);
    const signHelp = this.tsLanguageService.getSignatureHelpItems(fileFsPath, scriptDoc.offsetAt(position));
    if (!signHelp) {
      return NULL_SIGNATURE;
    }
    const ret: SignatureHelp = {
      activeSignature: signHelp.selectedItemIndex,
      activeParameter: signHelp.argumentIndex,
      signatures: []
    };
    signHelp.items.forEach(item => {
      const signature: SignatureInformation = {
        label: '',
        documentation: undefined,
        parameters: []
      };

      signature.label += this.tsModule.displayPartsToString(item.prefixDisplayParts);
      item.parameters.forEach((p, i, a) => {
        const label = this.tsModule.displayPartsToString(p.displayParts);
        const parameter: ParameterInformation = {
          label,
          documentation: this.tsModule.displayPartsToString(p.documentation)
        };
        signature.label += label;
        signature.parameters!.push(parameter);
        if (i < a.length - 1) {
          signature.label += this.tsModule.displayPartsToString(item.separatorDisplayParts);
        }
      });
      signature.label += this.tsModule.displayPartsToString(item.suffixDisplayParts);
      ret.signatures.push(signature);
    });
    return ret;
  }
  findDocumentHighlight(doc: TextDocument, position: Position): DocumentHighlight[] {
    const { scriptDoc } = this.updateCurrentTextDocument(doc);
    if (!languageServiceIncludesFile(this.tsLanguageService, doc.uri)) {
      return [];
    }

    const fileFsPath = getFileFsPath(doc.uri);
    const occurrences = this.tsLanguageService.getOccurrencesAtPosition(fileFsPath, scriptDoc.offsetAt(position));
    if (occurrences) {
      return occurrences.map(entry => {
        return {
          range: convertRange(scriptDoc, entry.textSpan),
          kind: entry.isWriteAccess ? DocumentHighlightKind.Write : DocumentHighlightKind.Text
        };
      });
    }
    return [];
  }
  findDocumentSymbols(doc: TextDocument): SymbolInformation[] {
    const { scriptDoc } = this.updateCurrentTextDocument(doc);
    if (!languageServiceIncludesFile(this.tsLanguageService, doc.uri)) {
      return [];
    }

    const fileFsPath = getFileFsPath(doc.uri);
    const items = this.tsLanguageService.getNavigationBarItems(fileFsPath);
    if (!items) {
      return [];
    }
    const result: SymbolInformation[] = [];
    const existing: { [k: string]: boolean } = {};
    const collectSymbols = (item: NavigationBarItem, containerLabel?: string) => {
      const sig = item.text + item.kind + item.spans[0].start;
      if (item.kind !== 'script' && !existing[sig]) {
        const symbol: SymbolInformation = {
          name: item.text,
          kind: convertSymbolKind(item.kind),
          location: {
            uri: doc.uri,
            range: convertRange(scriptDoc, item.spans[0])
          },
          containerName: containerLabel
        };
        existing[sig] = true;
        result.push(symbol);
        containerLabel = item.text;
      }

      if (item.childItems && item.childItems.length > 0) {
        for (const child of item.childItems) {
          collectSymbols(child, containerLabel);
        }
      }
    };

    items.forEach(item => collectSymbols(item));
    return result;
  }
  findDefinition(doc: TextDocument, position: Position): Definition {
    const { scriptDoc } = this.updateCurrentTextDocument(doc);
    if (!languageServiceIncludesFile(this.tsLanguageService, doc.uri)) {
      return [];
    }

    const fileFsPath = getFileFsPath(doc.uri);
    const definitions = this.tsLanguageService.getDefinitionAtPosition(fileFsPath, scriptDoc.offsetAt(position));
    if (!definitions) {
      return [];
    }

    const definitionResults: Definition = [];
    const program = this.tsLanguageService.getProgram();
    if (!program) {
      return [];
    }
    definitions.forEach(d => {
      const definitionTargetDoc = getSourceDoc(d.fileName, program);
      definitionResults.push({
        uri: Uri.file(d.fileName).toString(),
        range: convertRange(definitionTargetDoc, d.textSpan)
      });
    });
    return definitionResults;
  }
  findReferences(doc: TextDocument, position: Position): Location[] {
    const { scriptDoc } = this.updateCurrentTextDocument(doc);
    if (!languageServiceIncludesFile(this.tsLanguageService, doc.uri)) {
      return [];
    }

    const fileFsPath = getFileFsPath(doc.uri);
    const references = this.tsLanguageService.getReferencesAtPosition(fileFsPath, scriptDoc.offsetAt(position));
    if (!references) {
      return [];
    }

    const referenceResults: Location[] = [];
    const program = this.tsLanguageService.getProgram();
    if (!program) {
      return [];
    }
    references.forEach(r => {
      const referenceTargetDoc = getSourceDoc(r.fileName, program);
      if (referenceTargetDoc) {
        referenceResults.push({
          uri: Uri.file(r.fileName).toString(),
          range: convertRange(referenceTargetDoc, r.textSpan)
        });
      }
    });
    return referenceResults;
  }
  format(doc: TextDocument, range: Range, formatParams: FormattingOptions): TextEdit[] {
    const { scriptDoc } = this.updateCurrentTextDocument(doc);

    const defaultFormatter =
      scriptDoc.languageId === 'javascript'
        ? this.config.vetur.format.defaultFormatter.js
        : this.config.vetur.format.defaultFormatter.ts;

    if (defaultFormatter === 'none') {
      return [];
    }

    const parser = scriptDoc.languageId === 'javascript' ? 'babylon' : 'typescript';
    const needInitialIndent = this.config.vetur.format.scriptInitialIndent;
    const vlsFormatConfig: VLSFormatConfig = this.config.vetur.format;

    if (defaultFormatter === 'prettier' || defaultFormatter === 'prettier-eslint') {
      const code = scriptDoc.getText();
      const filePath = getFileFsPath(scriptDoc.uri);

      return defaultFormatter === 'prettier'
        ? prettierify(code, filePath, range, vlsFormatConfig, parser, needInitialIndent)
        : prettierEslintify(code, filePath, range, vlsFormatConfig, parser, needInitialIndent);
    } else {
      const initialIndentLevel = needInitialIndent ? 1 : 0;
      const formatSettings: FormatCodeSettings =
        scriptDoc.languageId === 'javascript' ? this.config.javascript.format : this.config.typescript.format;
      const convertedFormatSettings = convertOptions(
        formatSettings,
        {
          tabSize: vlsFormatConfig.options.tabSize,
          insertSpaces: !vlsFormatConfig.options.useTabs
        },
        initialIndentLevel
      );

      const fileFsPath = getFileFsPath(doc.uri);
      const start = scriptDoc.offsetAt(range.start);
      const end = scriptDoc.offsetAt(range.end);
      const edits = this.tsLanguageService.getFormattingEditsForRange(fileFsPath, start, end, convertedFormatSettings);

      if (!edits) {
        return [];
      }
      const result = [];
      for (const edit of edits) {
        if (edit.span.start >= start && edit.span.start + edit.span.length <= end) {
          result.push({
            range: convertRange(scriptDoc, edit.span),
            newText: edit.newText
          });
        }
      }
      return result;
    }
  }

  /**
   * LSP section end
   */

  onDocumentRemoved(document: TextDocument) {
    this.jsDocuments.onDocumentRemoved(document);
  }
  onDocumentChanged(filePath: string) {
    this.updateExternalDocument(filePath);
  }
  dispose() {
    this.tsLanguageService.dispose();
    this.jsDocuments.dispose();
  }
}

function getSourceDoc(fileName: string, program: Program): TextDocument {
  const sourceFile = program.getSourceFile(fileName)!;
  return TextDocument.create(fileName, 'vue', 0, sourceFile.getFullText());
}

function languageServiceIncludesFile(ls: LanguageService, documentUri: string): boolean {
  const filePaths = ls.getProgram()!.getRootFileNames();
  const filePath = getFilePath(documentUri);
  return filePaths.includes(filePath);
}

function convertRange(document: TextDocument, span: TextSpan): Range {
  const startPosition = document.positionAt(span.start);
  const endPosition = document.positionAt(span.start + span.length);
  return Range.create(startPosition, endPosition);
}

function convertKind(kind: ScriptElementKind): CompletionItemKind {
  switch (kind) {
    case 'primitive type':
    case 'keyword':
      return CompletionItemKind.Keyword;
    case 'var':
    case 'local var':
      return CompletionItemKind.Variable;
    case 'property':
    case 'getter':
    case 'setter':
      return CompletionItemKind.Field;
    case 'function':
    case 'method':
    case 'construct':
    case 'call':
    case 'index':
      return CompletionItemKind.Function;
    case 'enum':
      return CompletionItemKind.Enum;
    case 'module':
      return CompletionItemKind.Module;
    case 'class':
      return CompletionItemKind.Class;
    case 'interface':
      return CompletionItemKind.Interface;
    case 'warning':
      return CompletionItemKind.File;
  }

  return CompletionItemKind.Property;
}

function convertSymbolKind(kind: ScriptElementKind): SymbolKind {
  switch (kind) {
    case 'var':
    case 'local var':
    case 'const':
      return SymbolKind.Variable;
    case 'function':
    case 'local function':
      return SymbolKind.Function;
    case 'enum':
      return SymbolKind.Enum;
    case 'module':
      return SymbolKind.Module;
    case 'class':
      return SymbolKind.Class;
    case 'interface':
      return SymbolKind.Interface;
    case 'method':
      return SymbolKind.Method;
    case 'property':
    case 'getter':
    case 'setter':
      return SymbolKind.Property;
  }
  return SymbolKind.Variable;
}

function convertOptions(
  formatSettings: FormatCodeSettings,
  options: FormattingOptions,
  initialIndentLevel: number
): FormatCodeSettings {
  return _.assign(formatSettings, {
    convertTabsToSpaces: options.insertSpaces,
    tabSize: options.tabSize,
    indentSize: options.tabSize,
    baseIndentSize: options.tabSize * initialIndentLevel
  });
}

function convertCodeAction(
  doc: TextDocument,
  codeActions: CodeAction[],
  regionStart: LanguageModelCache<LanguageRange | undefined>
) {
  const textEdits: TextEdit[] = [];
  for (const action of codeActions) {
    for (const change of action.changes) {
      textEdits.push(
        ...change.textChanges.map(tc => {
          // currently, only import codeAction is available
          // change start of doc to start of script region
          if (tc.span.start === 0 && tc.span.length === 0) {
            const region = regionStart.get(doc);
            if (region) {
              const line = region.start.line;
              return {
                range: Range.create(line + 1, 0, line + 1, 0),
                newText: tc.newText
              };
            }
          }
          return {
            range: convertRange(doc, tc.span),
            newText: tc.newText
          };
        })
      );
    }
  }
  return textEdits;
}
