const SKILL_NAME_FIELDS = ["skill", "name", "command"] as const;

export function readSkillName(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const trimmedNames = SKILL_NAME_FIELDS.map((fieldName) => {
    const value: unknown = Reflect.get(input, fieldName);
    return typeof value === "string" ? value.trim() : "";
  });
  return trimmedNames.find((skillName) => skillName !== "");
}
