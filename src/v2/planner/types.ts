export type PiPlannerStreamHandlers = {
  onDelta?: (text: string) => void;
};

export type PiPlannerClient = {
  generate(prompt: string): Promise<string>;
  generateStream?: (prompt: string, handlers?: PiPlannerStreamHandlers) => Promise<string>;
};
