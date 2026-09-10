// Shared runtime namespace for both plugin loaders. Keep Geode-only exports
// separate from the unchanged Obsidian compatibility surface.
export * from "./obsidian";
export { CommentService, StaleCommentWriteError } from "../comments/service";
