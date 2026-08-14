import moment from "moment";
import { formatDate, relativeDate } from "../date-math";
import { evaluateArgs } from "../evaluator";
import { bool, dateValue, nullValue, num, str } from "../value";
import { MethodFn } from "./any-methods";

function asDate(target: Parameters<MethodFn>[0]): number | null {
  return target.type === "date" ? target.value : null;
}

export const DATE_METHODS: Record<string, MethodFn> = {
  year: (target) => {
    const d = asDate(target);
    return d === null ? nullValue() : num(moment(d).year());
  },
  month: (target) => {
    const d = asDate(target);
    return d === null ? nullValue() : num(moment(d).month() + 1);
  },
  day: (target) => {
    const d = asDate(target);
    return d === null ? nullValue() : num(moment(d).date());
  },
  hour: (target) => {
    const d = asDate(target);
    return d === null ? nullValue() : num(moment(d).hour());
  },
  minute: (target) => {
    const d = asDate(target);
    return d === null ? nullValue() : num(moment(d).minute());
  },
  second: (target) => {
    const d = asDate(target);
    return d === null ? nullValue() : num(moment(d).second());
  },
  millisecond: (target) => {
    const d = asDate(target);
    return d === null ? nullValue() : num(moment(d).millisecond());
  },

  date: (target) => {
    const d = asDate(target);
    return d === null ? nullValue() : dateValue(moment(d).startOf("day").valueOf());
  },

  format: (target, args, ctx) => {
    const d = asDate(target);
    if (d === null) return nullValue();
    const [patternArg] = evaluateArgs(args, ctx);
    if (patternArg?.type !== "string") return nullValue();
    return str(formatDate(d, patternArg.value));
  },

  // Not detailed by the spec beyond "-> string"; HH:mm:ss is the natural
  // time-only complement to .date()'s "strip time" behavior.
  time: (target) => {
    const d = asDate(target);
    return d === null ? nullValue() : str(moment(d).format("HH:mm:ss"));
  },

  relative: (target, _args, ctx) => {
    const d = asDate(target);
    return d === null ? nullValue() : str(relativeDate(d, ctx.now));
  },

  isEmpty: (target) => (target.type === "date" ? bool(false) : nullValue()),
};
