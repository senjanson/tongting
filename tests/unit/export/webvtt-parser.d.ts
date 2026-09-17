// webvtt-parser 未自带类型声明；仅声明测试用到的部分。
declare module 'webvtt-parser' {
  export interface ParsedVttCue {
    id: string;
    startTime: number;
    endTime: number;
    text: string;
  }
  export interface ParsedVtt {
    cues: ParsedVttCue[];
    errors: { message: string; line: number; col?: number }[];
  }
  export class WebVTTParser {
    parse(input: string, mode?: 'metadata' | 'chapters'): ParsedVtt;
  }
}
