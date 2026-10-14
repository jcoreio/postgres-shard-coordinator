export interface Clock<Id = NodeJS.Timeout> {
  readonly setTimeout: (callback: () => void, ms: number) => Id
  readonly clearTimeout: (id: Id) => void
  readonly setInterval: (callback: () => void, ms: number) => Id
  readonly clearInterval: (id: Id) => void
  readonly now: number
}
export const defaultClock: Clock = {
  setTimeout: setTimeout.bind(undefined),
  clearTimeout: clearTimeout.bind(undefined),
  setInterval: setInterval.bind(undefined),
  clearInterval: clearInterval.bind(undefined),
  get now(): number {
    return Date.now()
  },
}
