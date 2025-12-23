
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export enum GameState {
  LOADING = 'LOADING',
  READY = 'READY',
  PLAYING = 'PLAYING',
  ERROR = 'ERROR'
}

export interface FeedbackText {
  id: number;
  text: string;
  type: 'HIT' | 'MISS';
  x: number;
  y: number;
  life: number;
}
