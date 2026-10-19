import { fireEvent, render, screen } from "@testing-library/vue";
import { expect, it } from "vitest";
import VirtualNameQueue from "./VirtualNameQueue.vue";

it("starts a trimmed nonempty line queue while preserving duplicate names", async () => {
  const view = render(VirtualNameQueue, { props: { names: [], index: 0, busy: false } });
  await fireEvent.click(screen.getByText("名单逐项选片"));
  await fireEvent.update(screen.getByLabelText("影片名单"), "  蜘蛛侠  \r\n\r\n  仙逆\n蜘蛛侠\n  ");
  await fireEvent.click(screen.getByRole("button", { name: "开始逐项选片" }));
  expect(view.emitted().start).toEqual([[["蜘蛛侠", "仙逆", "蜘蛛侠"]]]);
});

it("does not start empty or blank-only lists", async () => {
  const view = render(VirtualNameQueue, { props: { names: [], index: 0, busy: false } });
  await fireEvent.click(screen.getByText("名单逐项选片"));
  await fireEvent.update(screen.getByLabelText("影片名单"), "  \n\r\n ");
  expect(screen.getByRole("button", { name: "开始逐项选片" })).toBeDisabled();
  await fireEvent.submit(screen.getByLabelText("影片名单").closest("form")!);
  expect(view.emitted().start).toBeUndefined();
});

it("shows the current entry and delegates skipping and stopping without replacing the list", async () => {
  const view = render(VirtualNameQueue, { props: { names: ["电影", "整部剧"], index: 1, busy: false } });
  expect(screen.getByRole("status")).toHaveTextContent("名单进度 2 / 2");
  expect(screen.getByRole("status")).toHaveTextContent("整部剧");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole("button", { name: "跳过此项" }));
  await fireEvent.click(screen.getByRole("button", { name: "结束名单" }));
  expect(view.emitted().skip).toEqual([[]]);
  expect(view.emitted().stop).toEqual([[]]);
});

it("disables startup while busy, including direct form submission", async () => {
  const view = render(VirtualNameQueue, { props: { names: [], index: 0, busy: true } });
  await fireEvent.click(screen.getByText("名单逐项选片"));
  await fireEvent.update(screen.getByLabelText("影片名单"), "电影");
  expect(screen.getByLabelText("影片名单")).toBeDisabled();
  expect(screen.getByRole("button", { name: "开始逐项选片" })).toBeDisabled();
  await fireEvent.submit(screen.getByLabelText("影片名单").closest("form")!);
  expect(view.emitted().start).toBeUndefined();
});

it("disables skip and stop during a search or addition", async () => {
  const view = render(VirtualNameQueue, { props: { names: ["电影"], index: 0, busy: true } });
  const skip = screen.getByRole("button", { name: "跳过此项" });
  const stop = screen.getByRole("button", { name: "结束名单" });
  expect(skip).toBeDisabled();
  expect(stop).toBeDisabled();
  await fireEvent.click(skip);
  await fireEvent.click(stop);
  expect(view.emitted().skip).toBeUndefined();
  expect(view.emitted().stop).toBeUndefined();
});

it("shows completion after the final entry and permits ending the list", async () => {
  const view = render(VirtualNameQueue, { props: { names: ["电影"], index: 1, busy: false } });
  expect(screen.getByRole("status")).toHaveTextContent("名单已完成共 1 项");
  expect(screen.queryByRole("button", { name: "跳过此项" })).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole("button", { name: "结束名单" }));
  expect(view.emitted().stop).toEqual([[]]);
  await view.rerender({ names: [], index: 0, busy: false });
  expect(screen.getByText("名单逐项选片")).toBeInTheDocument();
});
