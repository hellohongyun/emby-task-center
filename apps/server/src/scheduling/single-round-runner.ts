/** Periodic ticks skip a busy round; stopping never cancels or starts another round. */
export function createSingleRoundRunner(task: () => Promise<void>) {
  let running = false;
  let stopped = false;
  return {
    async run(): Promise<void> {
      if (running || stopped) return;
      running = true;
      try {
        await task();
      } finally {
        running = false;
      }
    },
    stop(): void {
      stopped = true;
    },
  };
}
