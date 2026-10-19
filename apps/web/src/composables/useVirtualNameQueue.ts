import { computed, ref, watch, type Ref } from "vue";

interface Picker {
  selectedId: Ref<string>;
  searchTerm: Ref<string>;
  selectedItems: Ref<string[]>;
  saving: Ref<boolean>;
  sourceLoading: Ref<boolean>;
  loadSources: (reset?: boolean) => Promise<void>;
  addItems: () => Promise<boolean | undefined>;
}

/** A temporary name queue reuses the existing picker; only the user chooses IDs. */
export function useVirtualNameQueue(picker: Picker) {
  const names = ref<string[]>([]);
  const index = ref(0);
  const adding = ref(false);
  const busy = computed(() => picker.saving.value || picker.sourceLoading.value || adding.value);
  const active = computed(() => names.value.length > 0 && index.value < names.value.length);

  function stop() {
    names.value = [];
    index.value = 0;
  }
  watch(picker.selectedId, stop, { flush: "sync" });

  async function searchCurrent() {
    if (!active.value) return;
    const name = names.value[index.value];
    if (name === undefined) return;
    picker.searchTerm.value = name;
    picker.selectedItems.value = [];
    await picker.loadSources(true);
  }
  async function start(values: string[]) {
    if (busy.value || !picker.selectedId.value || names.value.length) return;
    names.value = values.map((value) => value.trim()).filter(Boolean);
    index.value = 0;
    await searchCurrent();
  }
  async function next() {
    if (busy.value || !active.value) return;
    index.value++;
    picker.selectedItems.value = [];
    await searchCurrent();
  }
  async function add() {
    if (busy.value) return false;
    const queue = names.value;
    const position = index.value;
    const library = picker.selectedId.value;
    const advance = active.value;
    adding.value = true;
    try {
      const saved = await picker.addItems();
      if (
        saved &&
        advance &&
        names.value === queue &&
        index.value === position &&
        picker.selectedId.value === library
      ) {
        index.value++;
        picker.selectedItems.value = [];
        await searchCurrent();
      }
      return !!saved;
    } finally {
      adding.value = false;
    }
  }
  return { names, index, busy, adding, start, next, stop, add };
}
