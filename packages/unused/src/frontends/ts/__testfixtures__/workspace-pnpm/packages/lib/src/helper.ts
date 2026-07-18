export const usedHelper = (): string => "used";
// deadHelper is exported but re-exported by nothing and imported by no one — a
// per-workspace DEAD EXPORT (helper.ts itself stays alive via usedHelper).
export const deadHelper = (): string => "dead";
