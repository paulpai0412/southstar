export interface CredentialProvider {
  resolve(name: string): Promise<string>;
  describe(name: string): string;
}

export class FakeCredentialProvider implements CredentialProvider {
  private readonly credentials: Record<string, string>;

  constructor(credentials: Record<string, string>) {
    this.credentials = credentials;
  }

  async resolve(name: string): Promise<string> {
    const value = this.credentials[name];
    if (!value) {
      throw new Error(`Missing fake credential ${name}`);
    }
    return value;
  }

  describe(name: string): string {
    return `credential:${name}`;
  }
}
