export type RecentMemoLike = {
  id: string;
  updatedAt: string;
};

export type MemoDayGroup<T extends RecentMemoLike> = {
  dayKey: string;
  memos: T[];
};

const pad = (value: number) => String(value).padStart(2, "0");

export const getDayKeyFromDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const getMemoDayKey = (isoTimestamp: string) => {
  const date = new Date(isoTimestamp);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return getDayKeyFromDate(date);
};

export const groupMemosByDay = <T extends RecentMemoLike>(memos: T[]): MemoDayGroup<T>[] => {
  const groups = new Map<string, T[]>();

  for (const memo of memos) {
    const dayKey = getMemoDayKey(memo.updatedAt);

    if (!dayKey) {
      continue;
    }

    const bucket = groups.get(dayKey);
    if (bucket) {
      bucket.push(memo);
    } else {
      groups.set(dayKey, [memo]);
    }
  }

  return Array.from(groups, ([dayKey, dayMemos]) => ({ dayKey, memos: dayMemos }));
};

export const getCalendarGridDayKeys = (year: number, monthIndex: number) => {
  const firstOfMonth = new Date(year, monthIndex, 1);
  const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const weekCount = Math.ceil((mondayOffset + daysInMonth) / 7);
  const dayKeys: string[] = [];

  for (let index = 0; index < weekCount * 7; index += 1) {
    dayKeys.push(getDayKeyFromDate(new Date(year, monthIndex, 1 - mondayOffset + index)));
  }

  return dayKeys;
};
