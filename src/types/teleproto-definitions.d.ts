declare module "teleproto/tl/generated/api-definitions.js" {
  export interface ArgConfig {
    isVector: boolean;
    isFlag: boolean;
    skipConstructorId: boolean;
    flagName: string | null;
    flagIndex: number;
    flagIndicator: boolean;
    type: string;
    useVectorId: boolean | null;
  }
  export interface Definition {
    name: string;
    namespace?: string;
    constructorId: number;
    subclassOfId: number;
    argsConfig: Record<string, ArgConfig>;
    result: string;
    isFunction: boolean;
  }
  const definitions: Definition[];
  export = definitions;
}
