import { bool, listValue, nullValue, str } from "../value";
import { MethodFn } from "./any-methods";

export const OBJECT_METHODS: Record<string, MethodFn> = {
  isEmpty: (target) => (target.type === "object" ? bool(Object.keys(target.value).length === 0) : nullValue()),
  keys: (target) => (target.type === "object" ? listValue(Object.keys(target.value).map(str)) : nullValue()),
  values: (target) => (target.type === "object" ? listValue(Object.values(target.value)) : nullValue()),
};
