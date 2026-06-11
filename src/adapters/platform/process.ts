export interface CommandSpec {
  argv: string[];
}

export function commandSpec(binary: string, args: string[]): CommandSpec {
  const argv = [binary, ...args];
  const invalid = argv.find((part) => containsShellChain(part));
  if (invalid) {
    throw new Error(`Refusing shell-chain command argument: ${invalid}`);
  }
  return { argv };
}

export function containsShellChain(value: string): boolean {
  return /&&|\|\||;/.test(value);
}
