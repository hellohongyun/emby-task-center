declare module "@jamescoyle/vue-icon" {
  import type { DefineComponent } from "vue";

  const SvgIcon: DefineComponent<{
    type?: string;
    path: string;
    size?: number | string;
    viewbox?: string;
    flip?: string;
    rotate?: number | string;
  }>;

  export default SvgIcon;
}
