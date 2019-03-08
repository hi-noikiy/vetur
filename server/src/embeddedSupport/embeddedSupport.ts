import { TextDocument, Position, Range } from 'vscode-languageserver-types';
import { parseVueDocumentRegions, EmbeddedRegion } from './vueDocumentRegionParser';

export type LanguageId =
  | 'vue'
  | 'vue-html'
  | 'pug'
  | 'css'
  | 'postcss'
  | 'scss'
  | 'less'
  | 'stylus'
  | 'javascript'
  | 'typescript';

export interface LanguageRange extends Range {
  languageId: LanguageId;
  attributeValue?: boolean;
}

export interface VueDocumentRegions {
  getSingleLanguageDocument(languageId: LanguageId): TextDocument;
  getSingleTypeDocument(type: RegionType): TextDocument;

  getLanguageRangesOfType(type: RegionType): LanguageRange[];
  getLanguageRanges(): LanguageRange[];

  getLanguageAtPosition(position: Position): string;
  getLanguagesInDocument(): string[];
  getImportedScripts(): string[];
}

type RegionType = 'template' | 'script' | 'style' | 'custom';

const defaultType: { [type: string]: string } = {
  template: 'vue-html',
  script: 'javascript',
  style: 'css'
};

export function getVueDocumentRegions(document: TextDocument): VueDocumentRegions {
  const { regions, importedScripts } = parseVueDocumentRegions(document);

  return {
    getSingleLanguageDocument: (languageId: LanguageId) => getSingleLanguageDocument(document, regions, languageId),
    getSingleTypeDocument: (type: RegionType) => getSingleTypeDocument(document, regions, type),

    getLanguageRangesOfType: (type: RegionType) => getLanguageRangesOfType(document, regions, type),

    getLanguageRanges: () => getLanguageRanges(document, regions),
    getLanguageAtPosition: (position: Position) => getLanguageAtPosition(document, regions, position),
    getLanguagesInDocument: () => getLanguagesInDocument(document, regions),
    getImportedScripts: () => importedScripts
  };
}

function getLanguageRanges(document: TextDocument, regions: EmbeddedRegion[]): LanguageRange[] {
  return regions.map(r => {
    return {
      languageId: r.languageId,
      start: document.positionAt(r.start),
      end: document.positionAt(r.end)
    };
  });
}

function getLanguagesInDocument(document: TextDocument, regions: EmbeddedRegion[]): string[] {
  const result = ['vue'];
  for (const region of regions) {
    if (region.languageId && result.indexOf(region.languageId) === -1) {
      result.push(region.languageId);
    }
  }
  return result;
}

function getLanguageAtPosition(document: TextDocument, regions: EmbeddedRegion[], position: Position): string {
  const offset = document.offsetAt(position);
  for (const region of regions) {
    if (region.start <= offset) {
      if (offset <= region.end) {
        return region.languageId;
      }
    } else {
      break;
    }
  }
  return 'vue';
}

/**
 * Get a document where all regions of `languageId` is preserved
 * Whereas other regions are replaced with whitespaces
 */
export function getSingleLanguageDocument(
  document: TextDocument,
  regions: EmbeddedRegion[],
  languageId: LanguageId
): TextDocument {
  const oldContent = document.getText();
  let newContent = oldContent.replace(/./g, ' ');

  for (const r of regions) {
    if (r.languageId === languageId) {
      newContent = newContent.slice(0, r.start) + oldContent.slice(r.start, r.end) + newContent.slice(r.end);
    }
  }

  return TextDocument.create(document.uri, languageId, document.version, newContent);
}

/**
 * Get a document where all regions of `type` RegionType is preserved
 * Whereas other regions are replaced with whitespaces
 */
export function getSingleTypeDocument(
  document: TextDocument,
  regions: EmbeddedRegion[],
  type: RegionType
): TextDocument {
  const oldContent = document.getText();
  let newContent = oldContent.replace(/./g, ' ');

  for (const r of regions) {
    if (r.type === type) {
      newContent = newContent.slice(0, r.start) + oldContent.slice(r.start, r.end) + newContent.slice(r.end);
    }
  }

  return TextDocument.create(document.uri, defaultType[type], document.version, newContent);
}

export function getLanguageRangesOfType(
  document: TextDocument,
  regions: EmbeddedRegion[],
  type: RegionType
): LanguageRange[] {
  const result = [];

  for (const r of regions) {
    if (r.type === type) {
      result.push({
        start: document.positionAt(r.start),
        end: document.positionAt(r.end),
        languageId: r.languageId
      });
    }
  }

  return result;
}
