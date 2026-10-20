export const MEMO_REVISION_RETENTION_LIMIT = 100;

export type RevisionDiffRow = {
  lineNumber: number | null;
  text: string;
  state: "same" | "changed" | "empty";
};

export const buildRevisionDiffRows = (left: string, right: string) => {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const leftLength = leftLines.length;
  const rightLength = rightLines.length;
  const matrix: number[][] = Array.from({ length: leftLength + 1 }, () => Array(rightLength + 1).fill(0));

  for (let leftIndex = 1; leftIndex <= leftLength; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= rightLength; rightIndex += 1) {
      matrix[leftIndex][rightIndex] = leftLines[leftIndex - 1] === rightLines[rightIndex - 1]
        ? matrix[leftIndex - 1][rightIndex - 1] + 1
        : Math.max(matrix[leftIndex - 1][rightIndex], matrix[leftIndex][rightIndex - 1]);
    }
  }

  type DiffAction =
    | { type: "same"; left: string; right: string }
    | { type: "removed"; line: string }
    | { type: "added"; line: string };
  const actions: DiffAction[] = [];
  let leftIndex = leftLength;
  let rightIndex = rightLength;

  while (leftIndex > 0 || rightIndex > 0) {
    if (leftIndex > 0 && rightIndex > 0 && leftLines[leftIndex - 1] === rightLines[rightIndex - 1]) {
      actions.push({ type: "same", left: leftLines[leftIndex - 1], right: rightLines[rightIndex - 1] });
      leftIndex -= 1;
      rightIndex -= 1;
    } else if (rightIndex > 0 && (leftIndex === 0 || matrix[leftIndex][rightIndex - 1] >= matrix[leftIndex - 1][rightIndex])) {
      actions.push({ type: "added", line: rightLines[rightIndex - 1] });
      rightIndex -= 1;
    } else {
      actions.push({ type: "removed", line: leftLines[leftIndex - 1] });
      leftIndex -= 1;
    }
  }
  actions.reverse();

  const leftRows: RevisionDiffRow[] = [];
  const rightRows: RevisionDiffRow[] = [];
  let leftLineNumber = 1;
  let rightLineNumber = 1;
  let actionIndex = 0;

  while (actionIndex < actions.length) {
    const action = actions[actionIndex];
    if (action.type === "same") {
      leftRows.push({ lineNumber: leftLineNumber++, text: action.left, state: "same" });
      rightRows.push({ lineNumber: rightLineNumber++, text: action.right, state: "same" });
      actionIndex += 1;
      continue;
    }

    const removedLines: string[] = [];
    const addedLines: string[] = [];
    while (actionIndex < actions.length && actions[actionIndex].type !== "same") {
      const changedAction = actions[actionIndex];
      if (changedAction.type === "removed") {
        removedLines.push(changedAction.line);
      } else if (changedAction.type === "added") {
        addedLines.push(changedAction.line);
      }
      actionIndex += 1;
    }

    const changedBlockLength = Math.max(removedLines.length, addedLines.length);
    for (let index = 0; index < changedBlockLength; index += 1) {
      leftRows.push(index < removedLines.length
        ? { lineNumber: leftLineNumber++, text: removedLines[index], state: "changed" }
        : { lineNumber: null, text: "", state: "empty" });
      rightRows.push(index < addedLines.length
        ? { lineNumber: rightLineNumber++, text: addedLines[index], state: "changed" }
        : { lineNumber: null, text: "", state: "empty" });
    }
  }

  const changed = leftRows.reduce(
    (total, row, index) => total + (row.state !== "same" || rightRows[index]?.state !== "same" ? 1 : 0),
    0
  );

  return { changed, leftRows, rightRows };
};
