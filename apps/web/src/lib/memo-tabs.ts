export const MEMO_TAB_GAP_PX = 2;
export const MEMO_TAB_MORE_BUTTON_WIDTH_PX = 28;

export const addMemoTab = (tabs: string[], memoId: string) =>
  tabs.includes(memoId) ? tabs : [...tabs, memoId];

export const replaceActiveMemoTab = (tabs: string[], activeMemoId: string | null, memoId: string) => {
  if (tabs.includes(memoId)) {
    return tabs;
  }
  if (!activeMemoId || !tabs.includes(activeMemoId)) {
    return addMemoTab(tabs, memoId);
  }
  return tabs.map((id) => (id === activeMemoId ? memoId : id));
};

export const closeOtherMemoTabs = (tabs: string[], memoId: string) =>
  tabs.includes(memoId) ? [memoId] : tabs;

export const reorderMemoTabs = (tabs: string[], sourceId: string, targetId: string) => {
  const sourceIndex = tabs.indexOf(sourceId);
  const targetIndex = tabs.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
    return tabs;
  }

  const next = [...tabs];
  next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, sourceId);
  return next;
};

export const resolveMemoTabOverflow = ({
  tabWidths,
  availableWidth,
  activeIndex,
  gap = MEMO_TAB_GAP_PX,
  moreButtonWidth = MEMO_TAB_MORE_BUTTON_WIDTH_PX,
}: {
  tabWidths: number[];
  availableWidth: number;
  activeIndex: number;
  gap?: number;
  moreButtonWidth?: number;
}) => {
  const tabCount = tabWidths.length;
  if (tabCount === 0) {
    return { start: 0, count: 0 };
  }

  const totalWidth = tabWidths.reduce((sum, width) => sum + width, 0) + gap * (tabCount - 1);
  if (totalWidth <= availableWidth) {
    return { start: 0, count: tabCount };
  }

  const visibleCountFrom = (start: number) => {
    let count = 0;
    let usedWidth = 0;
    for (let index = start; index < tabCount; index += 1) {
      const nextWidth = usedWidth + tabWidths[index] + (count > 0 ? gap : 0);
      if (nextWidth + gap + moreButtonWidth > availableWidth) {
        break;
      }
      usedWidth = nextWidth;
      count += 1;
    }
    return count;
  };

  if (activeIndex < visibleCountFrom(0)) {
    return { start: 0, count: visibleCountFrom(0) };
  }

  for (let start = 1; start <= activeIndex; start += 1) {
    const count = visibleCountFrom(start);
    if (start + count > activeIndex) {
      return { start, count };
    }
  }

  return { start: 0, count: 0 };
};
