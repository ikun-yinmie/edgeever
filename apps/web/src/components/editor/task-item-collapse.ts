export const hasTaskItemSubContent = (childCount: number) => childCount > 1;

export const isTaskItemCollapsed = (collapsed: unknown) => collapsed === true;

export const resolveRenderedTaskItemCollapse = ({
  childCount,
  collapsed,
  editable,
}: {
  childCount: number;
  collapsed: unknown;
  editable: boolean;
}) => editable && hasTaskItemSubContent(childCount) && isTaskItemCollapsed(collapsed);
