/** Internal App-owned P1 admission budget; it is not a global memory/CPU limit. */
export class PdfDocumentLease {
  private pending: Promise<void> | undefined;
  constructor(private readonly cleanup: () => Promise<void>, private readonly release: () => void) {}
  close(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(this.cleanup).then(() => { this.release(); }, error => { this.pending = undefined; throw error; });
    return this.pending;
  }
}
export class PdfDocumentCapacity {
  private readonly active = new Set<PdfDocumentLease>();
  private closing: Promise<void> | undefined;
  get size(): number { return this.active.size; }
  /** Call before any PDF bytes read or iframe construction; failure starts no queue. */
  acquire(cleanup: () => Promise<void>): PdfDocumentLease | undefined {
    if (this.closing || this.active.size >= 4) return undefined;
    const lease = new PdfDocumentLease(cleanup, () => this.active.delete(lease)); this.active.add(lease); return lease;
  }
  closeAll(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.active].map(lease => lease.close()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "PDF documents could not finish closing.");
    }).finally(() => { this.closing = undefined; });
    return this.closing;
  }
}
const capacities = new WeakMap<object, PdfDocumentCapacity>();
export function pdfDocumentCapacity(app: object): PdfDocumentCapacity {
  let capacity = capacities.get(app); if (!capacity) { capacity = new PdfDocumentCapacity(); capacities.set(app, capacity); } return capacity;
}
