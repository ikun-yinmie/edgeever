export type RendererErrorSection = {
  label: string;
  value: string;
};

export type RendererErrorDetails = {
  kind: string;
  message: string;
  stack: string;
  componentStack: string;
};

export const getRendererErrorSections = (
  error: RendererErrorDetails | null,
  isChinese: boolean,
): RendererErrorSection[] => {
  if (!error) return [];

  return [
    { label: isChinese ? "错误类型" : "Error type", value: error.kind },
    { label: isChinese ? "错误消息" : "Error message", value: error.message },
    { label: isChinese ? "JavaScript 堆栈" : "JavaScript stack", value: error.stack },
    { label: isChinese ? "组件堆栈" : "Component stack", value: error.componentStack },
  ].filter((section) => section.value.trim().length > 0);
};

export const formatRendererErrorReport = (sections: RendererErrorSection[]) => sections
  .map(({ label, value }) => `## ${label}\n\n${value}`)
  .join("\n\n");
