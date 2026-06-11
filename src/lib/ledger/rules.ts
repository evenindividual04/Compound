/**
 * Auto-categorization rules engine.
 *
 * Rules are deterministic and run against transaction entries. They NEVER
 * overwrite a category the user set manually — that protection is enforced
 * inside annotate() (it checks categoryLocked when source starts with 'rule:').
 * We always write through annotate().
 *
 * Amount conditions compare the signed amount as stored; expenses are negative.
 * e.g. "-642.00" lt "-500.00" is TRUE because −642 < −500.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { cmp } from "@/lib/money";
import { annotate } from "./write";

// ── Types re-exported from schema for convenience ─────────────────────────────

type RuleRow = typeof schema.rules.$inferSelect;
type Condition = NonNullable<RuleRow["conditions"]>[number];
type Action = NonNullable<RuleRow["actions"]>[number];

export type { RuleRow as Rule };

export interface RuleInput {
  description: string;
  merchant: string | null;
  amount: string;
}

// ── Pure evaluator ─────────────────────────────────────────────────────────────

function evaluateCondition(cond: Condition, input: RuleInput): boolean {
  const { field, op, value } = cond;

  if (field === "amount") {
    // Amount operations: gt / lt / equals use cmp(); contains is not meaningful on amounts.
    if (op === "gt") return cmp(input.amount, value) > 0;
    if (op === "lt") return cmp(input.amount, value) < 0;
    if (op === "equals") return cmp(input.amount, value) === 0;
    // contains on amount field → false (not meaningful)
    return false;
  }

  // description or merchant
  const raw = field === "description" ? input.description : input.merchant;

  // null merchant never matches
  if (raw === null) return false;

  const haystack = raw.toLowerCase();
  const needle = value.toLowerCase();

  if (op === "contains") return haystack.includes(needle);
  if (op === "equals") return haystack === needle;
  // gt / lt on text fields → false (not meaningful)
  return false;
}

/**
 * Evaluate a single rule against an input. Returns the rule's actions if the
 * rule matches, or an empty array if it does not.
 *
 * Rules with zero conditions match nothing.
 */
export function evaluateRule(rule: RuleRow, input: RuleInput): Action[] {
  const conditions = rule.conditions ?? [];
  if (conditions.length === 0) return [];

  const matched =
    rule.matchMode === "any"
      ? conditions.some((c) => evaluateCondition(c, input))
      : conditions.every((c) => evaluateCondition(c, input));

  return matched ? (rule.actions ?? []) : [];
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

/**
 * Apply all active rules for a household to the given entry IDs.
 *
 * Priority is ascending-first (lower number = higher precedence). For each
 * action type (set_category, set_merchant, add_tag) the FIRST rule that fires
 * wins; later rules cannot override it.
 *
 * Tag actions are additive — every matching rule's add_tag fires (deduped by
 * onConflictDoNothing). Unknown tag names are silently skipped.
 */
export async function applyRulesTo(
  db: Db,
  householdId: string,
  entryIds: string[],
): Promise<void> {
  if (entryIds.length === 0) return;

  // Load active rules ordered by priority ASC
  const rules = await db
    .select()
    .from(schema.rules)
    .where(
      and(eq(schema.rules.householdId, householdId), eq(schema.rules.active, true)),
    )
    .orderBy(schema.rules.priority);

  for (const entryId of entryIds) {
    // Load entry (skip deleted)
    const [entry] = await db
      .select()
      .from(schema.entries)
      .where(and(eq(schema.entries.id, entryId), isNull(schema.entries.deletedAt)));
    if (!entry) continue;

    // Must be a transaction entry
    const [txn] = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.entryId, entryId));
    if (!txn) continue;

    const input: RuleInput = {
      description: entry.description,
      merchant: txn.merchant,
      amount: entry.amount,
    };

    // Walk rules, collecting the FIRST winner for each action type.
    // Tags are collected from all matching rules.
    let winningCategoryId: string | undefined;
    let winningCategoryRuleId: string | undefined;
    let winningMerchant: string | undefined;
    let winningMerchantRuleId: string | undefined;
    const tagActions: Array<{ value: string; ruleId: string }> = [];

    for (const rule of rules) {
      const actions = evaluateRule(rule, input);
      for (const action of actions) {
        if (action.type === "set_category" && winningCategoryId === undefined) {
          winningCategoryId = action.value;
          winningCategoryRuleId = rule.id;
        } else if (action.type === "set_merchant" && winningMerchant === undefined) {
          winningMerchant = action.value;
          winningMerchantRuleId = rule.id;
        } else if (action.type === "add_tag") {
          tagActions.push({ value: action.value, ruleId: rule.id });
        }
      }
    }

    // Apply set_category and set_merchant via annotate().
    // If both come from the same rule, one annotate call suffices.
    // If they come from different rules, two calls are needed so the source is accurate.
    if (winningCategoryId !== undefined && winningMerchant !== undefined) {
      if (winningCategoryRuleId === winningMerchantRuleId) {
        await annotate(
          db,
          entryId,
          { categoryId: winningCategoryId, merchant: winningMerchant },
          `rule:${winningCategoryRuleId}`,
        );
      } else {
        await annotate(
          db,
          entryId,
          { categoryId: winningCategoryId },
          `rule:${winningCategoryRuleId}`,
        );
        await annotate(
          db,
          entryId,
          { merchant: winningMerchant },
          `rule:${winningMerchantRuleId}`,
        );
      }
    } else if (winningCategoryId !== undefined) {
      await annotate(
        db,
        entryId,
        { categoryId: winningCategoryId },
        `rule:${winningCategoryRuleId}`,
      );
    } else if (winningMerchant !== undefined) {
      await annotate(
        db,
        entryId,
        { merchant: winningMerchant },
        `rule:${winningMerchantRuleId}`,
      );
    }

    // Apply add_tag actions: look up tag by (householdId, name), insert if found.
    for (const { value: tagName } of tagActions) {
      const [tag] = await db
        .select()
        .from(schema.tags)
        .where(
          and(
            eq(schema.tags.householdId, householdId),
            eq(schema.tags.name, tagName),
          ),
        );
      if (!tag) continue; // unknown tag name → silent no-op
      await db
        .insert(schema.entryTags)
        .values({ entryId, tagId: tag.id })
        .onConflictDoNothing();
    }
  }
}
