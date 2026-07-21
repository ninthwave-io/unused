import { pathToFileURL } from "node:url";
import {
  polyglotAnalyzer,
  polyglotFixturesRoot,
  polyglotScoreboardPath,
} from "./polyglot-corpus.js";
import { generateScoreboard, writeScoreboard } from "./scoreboard.js";

async function main(): Promise<void> {
  const scoreboard = await generateScoreboard(polyglotAnalyzer, polyglotFixturesRoot());
  await writeScoreboard(scoreboard, polyglotScoreboardPath());
  process.stdout.write(
    `wrote ${polyglotScoreboardPath()} (cases=${scoreboard.corpus.cases}, ` +
      `precision=${scoreboard.precision}, recall=${scoreboard.recall})\n`,
  );
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
