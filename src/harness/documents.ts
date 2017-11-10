/// <reference path="harness.ts" />

namespace documents {
    export class TextDocument {
        public readonly meta: Map<string, string>;
        public readonly file: string;
        public readonly text: string;

        private _lineStarts: number[] | undefined;

        constructor(file: string, content: string, meta?: Map<string, string>) {
            this.file = file;
            this.text = content;
            this.meta = meta || new Map<string, string>();
        }

        public get lineStarts(): number[] {
            return this._lineStarts || (this._lineStarts = ts.computeLineStarts(this.text));
        }
    }

    export interface RawSourceMap {
        version: number;
        file: string;
        sourceRoot?: string;
        sources: string[];
        sourcesContent?: string[];
        names: string[];
        mappings: string;
    }

    export interface Mapping {
        mappingIndex: number;
        emittedLine: number;
        emittedColumn: number;
        sourceIndex: number;
        sourceLine: number;
        sourceColumn: number;
        nameIndex?: number;
    }

    const mappingRegExp = /([A-Za-z0-9+/]+),?|(;)|./g;
    const sourceMappingURLRegExp = /^\/\/[#@]\s*sourceMappingURL\s*=\s*(.*?)\s*$/mig;
    const dataURLRegExp = /^data:application\/json;base64,([a-z0-9+/=]+)$/i;

    export class SourceMap {
        public readonly raw: RawSourceMap;
        public readonly mapFile: string | undefined;
        public readonly version: number;
        public readonly file: string;
        public readonly sourceRoot: string | undefined;
        public readonly sources: ReadonlyArray<string> = [];
        public readonly sourcesContent: ReadonlyArray<string> | undefined;
        public readonly mappings: ReadonlyArray<Mapping> = [];
        public readonly names: ReadonlyArray<string> | undefined;

        private _emittedLineMappings: Mapping[][] = [];
        private _sourceLineMappings: Mapping[][][] = [];

        constructor(mapFile: string | undefined, data: string | RawSourceMap) {
            this.raw = typeof data === "string" ? JSON.parse(data) as RawSourceMap : data;
            this.mapFile = mapFile;
            this.version = this.raw.version;
            this.file = this.raw.file;
            this.sourceRoot = this.raw.sourceRoot;
            this.sources = this.raw.sources;
            this.sourcesContent = this.raw.sourcesContent;
            this.names = this.raw.names;

            // populate mappings
            const mappings: Mapping[] = [];
            let emittedLine = 0;
            let emittedColumn = 0;
            let sourceIndex = 0;
            let sourceLine = 0;
            let sourceColumn = 0;
            let nameIndex = 0;
            let match: RegExpExecArray | null;
            while (match = mappingRegExp.exec(this.raw.mappings)) {
                if (match[1]) {
                    const segment = decodeVLQ(match[1]);
                    if (segment.length !== 1 && segment.length !== 4 && segment.length !== 5) {
                        throw new Error("Invalid VLQ");
                    }

                    emittedColumn += segment[0];
                    if (segment.length >= 4) {
                        sourceIndex += segment[1];
                        sourceLine += segment[2];
                        sourceColumn += segment[3];
                    }

                    const mapping: Mapping = { mappingIndex: mappings.length, emittedLine, emittedColumn, sourceIndex, sourceLine, sourceColumn };
                    if (segment.length === 5) {
                        nameIndex += segment[4];
                        mapping.nameIndex = nameIndex;
                    }

                    mappings.push(mapping);

                    const mappingsForEmittedLine = this._emittedLineMappings[mapping.emittedLine] || (this._emittedLineMappings[mapping.emittedLine] = []);
                    mappingsForEmittedLine.push(mapping);

                    const mappingsForSource = this._sourceLineMappings[mapping.sourceIndex] || (this._sourceLineMappings[mapping.sourceIndex] = []);
                    const mappingsForSourceLine = mappingsForSource[mapping.sourceLine] || (mappingsForSource[mapping.sourceLine] = []);
                    mappingsForSourceLine.push(mapping);
                }
                else if (match[2]) {
                    emittedLine++;
                    emittedColumn = 0;
                }
                else {
                    throw new Error(`Unrecognized character '${match[0]}'.`);
                }
            }

            this.mappings = mappings;
        }

        public static getUrl(text: string) {
            let match: RegExpExecArray | null;
            let lastMatch: RegExpExecArray | undefined;
            while (match = sourceMappingURLRegExp.exec(text)) {
                lastMatch = match;
            }
            return lastMatch ? lastMatch[1] : undefined;
        }

        public static fromUrl(url: string) {
            const match = dataURLRegExp.exec(url);
            return match ? new SourceMap(/*mapFile*/ undefined, new Buffer(match[1], "base64").toString("utf8")) : undefined;
        }

        public static fromSource(text: string) {
            const url = this.getUrl(text);
            return url && this.fromUrl(url);
        }

        public getMappingsForEmittedLine(emittedLine: number): ReadonlyArray<Mapping> | undefined {
            return this._emittedLineMappings[emittedLine];
        }

        public getMappingsForSourceLine(sourceIndex: number, sourceLine: number): ReadonlyArray<Mapping> | undefined {
            const mappingsForSource = this._sourceLineMappings[sourceIndex];
            return mappingsForSource && mappingsForSource[sourceLine];
        }
    }

    const base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    export function decodeVLQ(text: string) {
        const vlq: number[] = [];
        let shift = 0;
        let value = 0;
        for (let i = 0; i < text.length; i++) {
            const currentByte = base64Chars.indexOf(text.charAt(i));
            value += (currentByte & 31) << shift;
            if ((currentByte & 32) === 0) {
                vlq.push(value & 1 ? -(value >>> 1) : value >>> 1);
                shift = 0;
                value = 0;
            }
            else {
                shift += 5;
            }
        }
        return vlq;
    }
}