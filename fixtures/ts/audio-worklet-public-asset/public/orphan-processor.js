class OrphanProcessor extends AudioWorkletProcessor {
  process() {
    return false;
  }
}

registerProcessor("orphan-processor", OrphanProcessor);
