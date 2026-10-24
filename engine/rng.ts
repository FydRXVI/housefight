export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  static fromState(state: number): SeededRng {
    return new SeededRng(state);
  }

  getState(): number {
    return this.state >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(min: number, max: number): number {
    if (max < min) {
      throw new Error(`Invalid random range: ${min}..${max}`);
    }
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from an empty list.');
    }
    return items[this.int(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = this.int(0, index);
      [copy[index], copy[swapIndex]] = [copy[swapIndex] as T, copy[index] as T];
    }
    return copy;
  }
}
