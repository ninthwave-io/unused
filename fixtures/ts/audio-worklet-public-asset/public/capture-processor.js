class CaptureProcessor extends AudioWorkletProcessor {
  process() {
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
