import { usedHelper } from "@mono/lib";
import { slugify } from "@mono/utils/strings";

export const run = (): string => usedHelper() + slugify("X");
