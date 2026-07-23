/** Publicly audited semantic summaries for the Hex `money` package. */

import {
  defineElixirAtomRoleSummary,
  type ElixirAtomRoleSummaryProvider,
} from "../elixir/atom-role-summaries.js";
import type { ConventionPlugin } from "./types.js";

const moneyOrigin = { pluginId: "convention:money", hexPackage: "money" } as const;
const release = (version: string, innerChecksum: string, outerChecksum: string) => ({
  version,
  innerChecksum,
  outerChecksum,
});

/**
 * Exact public Hex release identity for every audited Money.new/2 implementation.
 * Provenance: `repo.hex.pm/tarballs/money-VERSION.tar` (`CHECKSUM` + whole-tar
 * SHA-256), cross-checked against `hex.pm/api/packages/money/releases/VERSION`.
 */
export const MONEY_AUDITED_RELEASES = [
  release(
    "1.0.0-beta",
    "1d95e377d97eeca73617033acfbbbc568775e66a00e11aac5e1235cbb60f4391",
    "9bef7fc48e920dc3568b505c1f546ddfe3a9cc111ca9fce40e466c815bab2600",
  ),
  release(
    "1.0.0",
    "78e36ba70b545ef1cd4426ce385fc70702b82efe63bcf9ad8c930960ffd10268",
    "a1ee1434a232e40d3a89145994685171fb76a7b72b15966031bd62bed00d5c41",
  ),
  release(
    "1.1.0",
    "875e865ed21b01ddee893a88da496b18ebbfb29fc472d4c782a41411372ea35d",
    "d64cbc53b8115fc9df92780d10fb95bcf1d100c8c959e30fbb19f85d75e4b4da",
  ),
  release(
    "1.1.1",
    "cd368db8dc066c5f1938f93eb65b90f8ab8f3150c962ec7a927c6941232ef246",
    "6d5b7a55af066ed98483ddd1a67a8155101597d141a1b943b8896399d56d4552",
  ),
  release(
    "1.1.2",
    "a24e8fcafd281a11f0b3764d6b350ba1ad92dc66eaadce84c5c02246bbb8c509",
    "c57667f1e9d73325d301a7d5b1fdeda350d901fc9dd557b5a4739de255d8b063",
  ),
  release(
    "1.1.3",
    "49bc3731da6a2405f9e936cdee57479956d567de95beaad08c4c1951a11a71c9",
    "290223b34623df460d2bc6bf372339a5354e69269f9a777c8575bfd4665fd6af",
  ),
  release(
    "1.2.0",
    "89064541fa77222bb769534ed946fd0cebde54e0b19a3d50797a344f1cf6337e",
    "64c6b9428a7129128935d77e980c759456830693f2a43dd88a3653084f05f48d",
  ),
  release(
    "1.2.1",
    "fdcc7b021b894dbcc2cd0f57d2ccdd2224eced747231337a849424ffaa196b13",
    "a45f2c2ffd41b1b118c9bc46076977165fe9b81f322a7fbc38817641d01ab548",
  ),
  release(
    "1.3.0",
    "320727165e091f77cdb965d864cbde6ba16f46bf868b03cdebd54023cfcaaba2",
    "953cf9f1a2843db773a053b0291699666ddbbed239f70c33fd136361c774379c",
  ),
  release(
    "1.3.1",
    "90e07d36d01b0b55eeaaf026f1f9c6d29d028589a8b3afbeba68743a7f550450",
    "0e5e46059ce5f951e1402832504f69fd6f4cf94e131dce55ec077021447108dd",
  ),
  release(
    "1.3.2",
    "013a80af36d64c89f51ae73a789cd004004d068b087b4632996b7cb0b66584f6",
    "d4fd4f34e29a2a6573106cd5b5afd28b9382acf3ca20e10782830ad05227a5c9",
  ),
  release(
    "1.4.0",
    "d9e1725832073566dc0c015603b1e82d69f5bd6c51299e9558e61aa6158044da",
    "acd1259cf1d6ab29f154dd171e8086fb3fe1e80bf5f70a1d0ec833ec1c8fc92c",
  ),
  release(
    "1.5.0",
    "e79db95bc2c45b9485ed158dbd2ad85beb7649d68c4f764d413e121d9c398e81",
    "e3c6c2933c1dad41c402c9a4c080f0604b02c68c0209a3d662c75a9e02fbe978",
  ),
  release(
    "1.5.1",
    "bc3982ac340acd26e93886c44f13dce33fe1719f35158b88b0aaa4e2cac897dc",
    "2087944fe96a44620fbc75cab2ce58882f536d36b3627997ceee1c3faac98bb2",
  ),
  release(
    "1.6.0",
    "5c99a8cb91f5d80edd0d94df59c2f267ddb2fe73f84b23969fab4443ffbeafcb",
    "9494c314c701cac989eb3a919a11c0790c7399cbfdca682dd08f9af500c3ca31",
  ),
  release(
    "1.6.1",
    "a37a7e128b0fe8391c5b6a0101ae028d05dd173ad9a17620db0bda4797cd8263",
    "e9a45a1f9f67548269aab5119a5253505dc64974bfc616d98fe084bf60db9e90",
  ),
  release(
    "1.7.0",
    "dbb4de602165d65095214e9162fa68d70ab63ff4a8fb39bf12b5b140b59fe6df",
    "c449f09b5d3340cd2f600f0ed5d0015130e7c6c124f9b5278af3dd6da4929b1c",
  ),
  release(
    "1.8.0",
    "e532023fbeccb5ca7d503e2d86434669428810a46bd2e3966ba5b063be4e0358",
    "b21aa903d3f91fed7e6dc921438ca1920c49af2e83df3025b4f3fb6981b483f6",
  ),
  release(
    "1.9.0",
    "aa71b22017631222b370d89d42a4dbf8e2cd123867dd84a67b36e7174030eb91",
    "26de969f9a44bfac30e5d04e503d48482cf395030b18bb0cc461d426a3c832ae",
  ),
  release(
    "1.10.0",
    "2167978b65b6044952e53ea66b0a64825eab5acc957d92f6a017d0be8132d122",
    "00307c61059de84b24d70f9c68b382238955a83868486b08e1f74896af3dd92f",
  ),
  release(
    "1.11.0",
    "18b0a2e4bc978b9b6e37dcce9659f339f3915889abd319d43d35e302857480b1",
    "2233183ddac2523938cf04db541e7dfc95d7223f19fb0c8f3163012cf3b4a92a",
  ),
  release(
    "1.12.0",
    "fd3bbed57fbf273b84e38712d48c0ddb35cac6cc91d0044b5094793160e9d35e",
    "9d6b1183214ef382aab7841c23431e043ce2645f21fc3c63bf47350adcccfd31",
  ),
  release(
    "1.12.1",
    "2816b306061422d4ea42f801d2b7910acc42ad0407b3702907c68c5b8a6a0367",
    "c952cd6beb14c66dbe905687060cc926a112432a62cd6114dddd466be0c45818",
  ),
  release(
    "1.12.2",
    "8d294c9c3805bfeeaeeffadb3d8c9dce1be5ab1236dc4e564728badcbb79510d",
    "d9cabe0549f0d815870c3832b2164afe1dab3802c76ba9cda8fd6199bd6383a9",
  ),
  release(
    "1.12.3",
    "a0396428e21c36c8a40462a1f17b6038781b2544d00696c8b27026205b54dbe4",
    "4902dcac18aca4788be9d6b04d1a59a5bcbceca700f33eab8fe13eb6a6c36dde",
  ),
  release(
    "1.12.4",
    "9d9817aa79d1317871f6b006721c264bf1910fb28ba2af50746514f0d7e8ddbe",
    "87e4bb907df1da184cb4640569d8df99ee6d88c84ce4f5da03cb2fab8d433eb9",
  ),
  release(
    "1.13.0",
    "b50b40970c498f1d2ad3c850ee31966b03a4c806ffd0ef001d1ead935e253af7",
    "d8b53b8eecc74de069af59f642e350819c24e43262b4e2628754457004b465bf",
  ),
  release(
    "1.13.1",
    "b437196bf698f85d2cad33ac3f65e1bc43a94673fddbf65605fe3a77922e208a",
    "d9719b775652b6249fa80aeecc5e505a5eeeab73f4f30ecd3f696c6830281dc5",
  ),
  release(
    "1.14.0",
    "61c1e9d9ae1dd45dae7f72568987b3e7275031c3f5a0bf8a053bd74259555934",
    "b8691009e0c31715d2e5a3cca68ca2e1a46895d63c11257b317d8801ee2c54e3",
  ),
  release(
    "1.15.0",
    "48ce20e3b0ab774fe8a41713869f70470365b899dcc80c6662c3c639cbe60bb8",
    "25a0400bd518a0dab4166563f3bd8625376b69da23563070b67fadf363663533",
  ),
] satisfies ElixirAtomRoleSummaryProvider["auditedReleases"];

export const MONEY_AUDITED_VERSIONS = MONEY_AUDITED_RELEASES.map((audited) => audited.version);

/** Semantic summaries owned by the provider-only Money convention plugin. */
export const moneyElixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider = {
  id: "convention:money",
  compilerApp: "money",
  otpApp: "money",
  lockKey: "money",
  hexPackage: "money",
  repository: "hexpm",
  auditedReleases: MONEY_AUDITED_RELEASES,
  summaries: [
    defineElixirAtomRoleSummary(
      "Money",
      "new",
      2,
      { 1: "propagate-to-result" },
      { origin: moneyOrigin },
    ),
  ],
};

/** Registered pre-graph semantic capability with no post-graph contribution. */
export const moneyElixirConventionPlugin: ConventionPlugin & {
  readonly elixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider;
} = {
  kind: "convention",
  id: "convention:money",
  version: "0.1.0",
  languages: ["ex"],
  elixirAtomRoleSummaryProvider: moneyElixirAtomRoleSummaryProvider,
  applies: () => false,
  async analyze() {
    return {};
  },
};
