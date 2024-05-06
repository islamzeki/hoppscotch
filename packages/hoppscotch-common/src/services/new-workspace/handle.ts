import { Ref, WritableComputedRef } from "vue"

export type HandleRef<T, InvalidateReason = unknown> = Ref<
  { type: "ok"; data: T } | { type: "invalid"; reason: InvalidateReason }
>

export type HandleState<T> =
  | { type: "valid"; data: T }
  | { type: "invalid"; reason: string }

export type Handle<T> = {
  get: () => Ref<HandleState<T>>
}

export type WritableHandleRef<
  T,
  InvalidateReason = unknown,
> = WritableComputedRef<
  { type: "ok"; data: T } | { type: "invalid"; reason: InvalidateReason }
>
