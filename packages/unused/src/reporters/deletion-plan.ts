/** Pure terminal rendering for ADR 0012 counterfactual deletion plans. */

export type DeletionPlanSubjectView =
  | {
      readonly kind: "export";
      readonly file: string;
      readonly name: string;
      readonly line?: number;
    }
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "dependency"; readonly file: string; readonly name: string };

export type DeletionPlanConsequenceSubjectView = Exclude<
  DeletionPlanSubjectView,
  { kind: "dependency" }
>;

export interface ReExportEditView {
  readonly kind: "remove-re-export";
  readonly file: string;
  readonly line: number;
  readonly exportedName?: string;
  readonly targetFile: string;
  readonly targetName?: string;
}

export interface DeletionPlanStageView {
  readonly stage: number;
  readonly newlyDead: readonly DeletionPlanConsequenceSubjectView[];
}

export type DeletionPlanView =
  | {
      readonly selected: DeletionPlanConsequenceSubjectView;
      readonly supported: true;
      readonly unsupportedReason?: never;
      readonly reExportEdits: readonly ReExportEditView[];
      readonly stages: readonly DeletionPlanStageView[];
    }
  | {
      readonly selected: DeletionPlanSubjectView;
      readonly supported: false;
      readonly unsupportedReason: string;
      readonly reExportEdits: readonly [];
      readonly stages: readonly [];
    };

export function deletionSubjectLabel(subject: DeletionPlanSubjectView): string {
  if (subject.kind === "file") return subject.file;
  if (subject.kind === "dependency") return `${subject.name} (${subject.file})`;
  return subject.line !== undefined
    ? `${subject.file}:${subject.line} ${subject.name}`
    : `${subject.name} (${subject.file})`;
}

/** Render a reviewable deletion plan. Plans are consequences, never verdicts. */
export function renderDeletionPlan(plan: DeletionPlanView, ascii: boolean): string {
  const dash = ascii ? "--" : "—";
  const arrow = ascii ? "->" : "→";
  const lines = [`deletion plan ${dash} ${deletionSubjectLabel(plan.selected)}`];
  if (!plan.supported) {
    lines.push("", `  no graph cascade: ${plan.unsupportedReason}`);
    return `${lines.join("\n")}\n`;
  }

  lines.push("", "  required re-export edits:");
  if (plan.reExportEdits.length === 0) {
    lines.push("    none");
  } else {
    for (const edit of plan.reExportEdits) {
      const exposed = edit.exportedName !== undefined ? ` \`${edit.exportedName}\`` : "";
      const target =
        edit.targetName !== undefined ? `${edit.targetFile}:${edit.targetName}` : edit.targetFile;
      lines.push(`    - ${edit.file}:${edit.line} remove re-export${exposed} ${arrow} ${target}`);
    }
  }

  lines.push("", "  newly dead after deletion:");
  if (plan.stages.length === 0) {
    lines.push("    none");
  } else {
    for (const stage of plan.stages) {
      lines.push(`    stage ${stage.stage}:`);
      for (const subject of stage.newlyDead) {
        lines.push(`      - ${deletionSubjectLabel(subject)}`);
      }
    }
  }
  lines.push("", `  consequence plan only ${dash} claim verdicts and gates are unchanged.`);
  return `${lines.join("\n")}\n`;
}
