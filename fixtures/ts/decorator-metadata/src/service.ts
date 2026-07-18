import { Injectable } from "./decorator.js";
import { Dep } from "./dep.js";

// Decorated class with no static importer by name (index.ts brings the file
// alive with a side-effect import only, for DI module registration). Under
// `emitDecoratorMetadata` this class's own export claim cannot be proven dead
// — the class may be DI-instantiated via `design:paramtypes` reflection with
// no visible import — so it is capped at medium.
@Injectable()
export class Service {
  constructor(private readonly dep: Dep) {}
}
