/**
 * howler.d.ts - ambient declarations
 * =============================================================================
 * Howler 2.2.4 ships no TypeScript types, and `@types/howler` is not a
 * dependency of this project. Rather than add one for the six members actually
 * used here, the surface is declared by hand.
 *
 * Deliberately minimal: only what `WaterAudio` touches. Anything else that
 * needs Howler should extend this file rather than widen the dependency.
 */

declare module 'howler' {
  export interface IHowlProperties {
    src: string | string[];
    loop?: boolean;
    volume?: number;
    html5?: boolean;
    preload?: boolean;
    autoplay?: boolean;
    /** Called once the sound can be played. */
    onload?: () => void;
    onloaderror?: (id: number, error: unknown) => void;
    onplayerror?: (id: number, error: unknown) => void;
  }

  export class Howl {
    constructor(properties: IHowlProperties);
    play(): number;
    pause(): this;
    stop(): this;
    volume(volume: number, id?: number): this | number;
    loop(loop?: boolean): this | boolean;
    playing(id?: number): boolean;
    state(): 'unloaded' | 'loading' | 'loaded';
    unload(): void;
    /** Stereo pan, -1 hard left to 1 hard right. */
    stereo(pan: number, id?: number): this | number;
    /** Stored source position. Used by the spatial plugin; kept for parity. */
    pos(x: number, y: number, z: number, id?: number): this;
  }

  export interface IHowlerGlobal {
    /** True once a Web Audio context exists and can be used. */
    readonly ctx: AudioContext | null;
    /** True when Howler fell back to HTML5 Audio instead of Web Audio. */
    readonly usingWebAudio: boolean;
    /** Master volume, 0 to 1. */
    volume(volume?: number): this | number;
    /** Position of the listener in world space. */
    pos(x: number, y: number, z: number): this;
    mute(muted?: boolean): this | boolean;
  }

  export const Howler: IHowlerGlobal;
  export const Howl: typeof Howl;
}
