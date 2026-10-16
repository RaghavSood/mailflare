export type PushStatusResponse = {
	configured: boolean;
	problems: string[];
	/** Null when the push_subscriptions table is not there yet (migration pending). */
	subscriptions: number | null;
	error?: string;
};
