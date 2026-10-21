/** A promise the test opens when it chooses, to hold work at a known point. */
export function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
	let open = (): void => {}
	const promise = new Promise<void>((resolve) => {
		open = resolve
	})
	return { promise, open }
}
