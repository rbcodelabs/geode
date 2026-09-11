export const resolutionFiles: Record<string, string> = {
  "folder/Source.md": "[[Other]] [[Twin]]",
  "Target.md": "# Details",
  "folder/Local.md": "",
  "a/Twin.md": "",
  "b/Twin.md": "",
  "deep/folder/Twin.md": "",
  "Alias.md": "---\naliases: [Other]\n---\n",
};
export const resolutionTargets = ["Target#Details", "Local", "Other", "#Details", "Twin", "../Target", "./Twin", "absent", "Target^block"];
