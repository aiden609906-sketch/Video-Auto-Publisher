export class PublishAccountBusyError extends Error {
  readonly code = "PUBLISH_ACCOUNT_BUSY";

  constructor(readonly key: string) {
    super(`A publish workflow is already running for ${key}`);
  }
}

export class PublishAccountLock {
  private readonly active = new Set<string>();

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(key)) {
      throw new PublishAccountBusyError(key);
    }

    this.active.add(key);
    try {
      return await operation();
    } finally {
      this.active.delete(key);
    }
  }
}
