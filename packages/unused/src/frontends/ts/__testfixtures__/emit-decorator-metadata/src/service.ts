import { Injectable } from "./decorator.js";
import type { Repo } from "./repo.js";

// Decorated class with no static importer: under `emitDecoratorMetadata` the
// `Repo` param type is a runtime metadata reference and the class is
// DI-instantiated, so `Service` cannot be proven dead — capped at medium.
@Injectable()
export class Service {
  constructor(private readonly repo: Repo) {}
}
