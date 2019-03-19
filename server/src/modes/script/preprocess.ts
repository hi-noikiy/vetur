import * as path from 'path';

import { getDocumentRegions } from '../embeddedSupport';
import { TextDocument } from 'vscode-languageserver-types';
import { T_TypeScript } from '../../services/dependencyService';
import {
  ScriptKind,
  SourceFile,
  IScriptSnapshot,
  ScriptTarget,
  TextChangeRange,
  ExportAssignment,
  ObjectLiteralExpression,
  CallExpression,
  TextRange,
  Statement
} from 'typescript';

export function isVue(filename: string): boolean {
  return path.extname(filename) === '.vue';
}

export function parseVue(text: string): string {
  const doc = TextDocument.create('test://test/test.vue', 'vue', 0, text);
  const regions = getDocumentRegions(doc);
  const script = regions.getEmbeddedDocumentByType('script');
  return script.getText() || 'export default {};';
}

function isTSLike(tsModule: T_TypeScript, scriptKind: ScriptKind | undefined) {
  return scriptKind === tsModule.ScriptKind.TS || scriptKind === tsModule.ScriptKind.TSX;
}

export function createUpdater(tsModule: T_TypeScript) {
  const clssf = tsModule.createLanguageServiceSourceFile;
  const ulssf = tsModule.updateLanguageServiceSourceFile;
  const scriptKindTracker = new WeakMap<SourceFile, ScriptKind | undefined>();

  return {
    createLanguageServiceSourceFile(
      fileName: string,
      scriptSnapshot: IScriptSnapshot,
      scriptTarget: ScriptTarget,
      version: string,
      setNodeParents: boolean,
      scriptKind?: ScriptKind
    ): SourceFile {
      const sourceFile = clssf(fileName, scriptSnapshot, scriptTarget, version, setNodeParents, scriptKind);
      scriptKindTracker.set(sourceFile, scriptKind);
      if (isVue(fileName) && !isTSLike(tsModule, scriptKind)) {
        modifyVueSource(tsModule, sourceFile);
      }
      return sourceFile;
    },
    updateLanguageServiceSourceFile(
      sourceFile: SourceFile,
      scriptSnapshot: IScriptSnapshot,
      version: string,
      textChangeRange: TextChangeRange,
      aggressiveChecks?: boolean
    ): SourceFile {
      const scriptKind = scriptKindTracker.get(sourceFile);
      sourceFile = ulssf(sourceFile, scriptSnapshot, version, textChangeRange, aggressiveChecks);
      if (isVue(sourceFile.fileName) && !isTSLike(tsModule, scriptKind)) {
        modifyVueSource(tsModule, sourceFile);
      }
      return sourceFile;
    }
  };
}

function modifyVueSource(tsModule: T_TypeScript, sourceFile: SourceFile): void {
  const exportDefaultObject = sourceFile.statements.find(
    st =>
      st.kind === tsModule.SyntaxKind.ExportAssignment &&
      (st as ExportAssignment).expression.kind === tsModule.SyntaxKind.ObjectLiteralExpression
  );
  if (exportDefaultObject) {
    // 1. add `import Vue from 'vue'
    //    (the span of the inserted statement must be (0,0) to avoid overlapping existing statements)
    const setZeroPos = getWrapperRangeSetter(tsModule, { pos: 0, end: 0 });
    const vueImport = setZeroPos(
      tsModule.createImportDeclaration(
        undefined,
        undefined,
        setZeroPos(tsModule.createImportClause(tsModule.createIdentifier('__vueEditorBridge'), undefined as any)),
        setZeroPos(tsModule.createLiteral('vue-editor-bridge'))
      )
    );
    const statements: Array<Statement> = sourceFile.statements as any;
    statements.unshift(vueImport);

    // 2. find the export default and wrap it in `__vueEditorBridge(...)` if it exists and is an object literal
    // (the span of the function construct call and *all* its members must be the same as the object literal it wraps)
    const objectLiteral = (exportDefaultObject as ExportAssignment).expression as ObjectLiteralExpression;
    const setObjPos = getWrapperRangeSetter(tsModule, objectLiteral);
    const vue = tsModule.setTextRange(tsModule.createIdentifier('__vueEditorBridge'), {
      pos: objectLiteral.pos,
      end: objectLiteral.pos + 1
    });
    (exportDefaultObject as ExportAssignment).expression = setObjPos(
      tsModule.createCall(vue, undefined, [objectLiteral])
    );
    setObjPos(((exportDefaultObject as ExportAssignment).expression as CallExpression).arguments!);
  }
}

/** Create a function that calls setTextRange on synthetic wrapper nodes that need a valid range */
function getWrapperRangeSetter(tsModule: T_TypeScript, wrapped: TextRange): <T extends TextRange>(wrapperNode: T) => T {
  return <T extends TextRange>(wrapperNode: T) => tsModule.setTextRange(wrapperNode, wrapped);
}
