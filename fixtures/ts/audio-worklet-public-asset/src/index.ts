export async function startAudio(context: AudioContext): Promise<void> {
  await context.audioWorklet.addModule("/capture-processor.js");
}
