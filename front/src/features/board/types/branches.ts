/** The badge a branch gets in the picker. The values are also the i18n keys `branchPicker.badge.*`. */
export type BranchHighlight = "default" | "production" | "main" | "development";

export interface RankedBranch {
  name: string;
  highlight: BranchHighlight | null;
}

export interface BranchPickerProps {
  id: string;
  value: string;
  onSelect: (branch: string) => void;
  branches: readonly string[];
  defaultBranch: string | null;
  refreshing: boolean;
  refreshFailed: boolean;
  truncated: boolean;
  onOpen: () => void;
  onRefresh: () => void;
  /** The row that stands for `value === ""` (e.g. inherit the project's branch). Without it, there is no empty row. */
  noChoiceLabel?: string;
}
