import { generateSyntheticVault } from "./synthetic-vault.mts";
const values = {};
for (const arg of process.argv.slice(2)) {
    const match = /^--(output|notes|profile|seed)=(.+)$/.exec(arg);
    if (!match || match[1] in values)
        throw Error("Usage: --output=/absolute/fresh/path [--notes=10000 --profile=linked --seed=1]");
    values[match[1]] = match[2];
}
if (!values.output)
    throw Error("--output=/absolute/fresh/path is required");
console.log(JSON.stringify(await generateSyntheticVault(values.output, {
    ...(values.notes ? { notes: Number(values.notes) } : {}),
    ...(values.seed ? { seed: Number(values.seed) } : {}),
    ...(values.profile ? { profile: values.profile } : {}),
}), null, 2));
