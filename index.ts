import type { ChildProcess, ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import stripAnsi from 'strip-ansi';

export enum Phase {
	Stopped = 'stopped',
	Stopping = 'stopping',
	Starting = 'starting',
	Started = 'started',
}

export type State = Readonly<
	{ phase: Phase.Stopped } | { phase: Phase.Stopping | Phase.Starting | Phase.Started; pid: number }
>;

export interface Manager {
	getState: () => State;
	start: (timeout?: number) => Promise<number>;
	stop: (timeout?: number) => Promise<void | number>;
}

// nano redux (no middleware or subscribers)
function createReducer<S, A>(params: { state: S; reducer: (state: S, action: A) => S }) {
	const { reducer } = params;
	let { state } = params;
	return {
		dispatch: (action: A) => {
			state = reducer(state, action);
		},
		getState: (): S => state,
	};
}

type InternalState = Readonly<
	| { phase: Phase.Stopped }
	| {
			phase: Phase.Starting;
			pid: number;
			child: ChildProcess;
			pending: { promise: Promise<number>; action: StartAction };
	  }
	| {
			phase: Phase.Stopping;
			pid: number;
			child: ChildProcess;
			pending: { promise: Promise<number>; action: StopAction };
	  }
	| { phase: Phase.Started; pid: number; child: ChildProcess }
>;

enum ActionType {
	Start = 'start',
	Stop = 'stop',
	Complete = 'complete',
	Fail = 'fail',
}

interface StartAction {
	readonly type: ActionType.Start;
	readonly timeout: number;
}

interface StopAction {
	readonly type: ActionType.Stop;
	readonly timeout: number;
}

interface CompleteAction {
	readonly type: ActionType.Complete;
	readonly action: StartAction | StopAction;
}

enum FailType {
	Close = 'close',
	Timeout = 'timeout',
}

interface FailAction {
	readonly type: ActionType.Fail;
	readonly action: StartAction | StopAction;
	readonly reason: FailType;
}

function errorForFail(fail: FailAction): Error {
	const { type: verb } = fail.action;
	switch (fail.reason) {
		case FailType.Close:
			return new Error(`The process failed to ${verb} because it closed`);
		case FailType.Timeout:
			return new Error(`Timeout waiting for process to ${verb}`);
		// no default
	}
}

/**
 * Takes a list of patterns and a starting pattern index.
 * Returns the first index of the pattern that doesn't match.
 * Patterns start testing after the previous match in the string.
 */
function nextPatternIndex(start = 0, patterns: RegExp[], str: string) {
	let index = start;
	let lastIndex = 0;
	const sliced = patterns.slice(start);
	for (const pattern of sliced) {
		pattern.lastIndex = lastIndex;
		if (!pattern.test(str)) return index;
		lastIndex = pattern.lastIndex;
		index++;
	}
	return -1;
}

/**
 * Takes a list of patterns and iterates over them
 * on every 'data' event from a node process object.
 * Patterns are expected to match in the order they are given.
 * When the patterns are all matched this returns true.
 */
function createIsStartedTest(isStartedPatterns: ReadonlyArray<RegExp>) {
	// eslint-disable-next-line security/detect-non-literal-regexp
	const patterns = isStartedPatterns.map((it) => new RegExp(it, 'g'));
	let index = 0;
	return function isStartedTest(chunk: any): boolean {
		if (chunk) {
			const str = stripAnsi(chunk.toString());
			index = nextPatternIndex(index, patterns, str);
			return index === -1;
		}
		return false;
	};
}

function createLogger(getState: () => State, name: string) {
	function prefix(): string {
		const state = getState();
		return state.phase !== Phase.Stopped ? `${name}(${state.phase}, ${state.pid}):` : `${name}(${state.phase}):`;
	}
	return {
		info: (str: string) => console.info(prefix(), str),
		warn: (str: string) => console.warn(prefix(), str),
		error: (str: string) => console.error(prefix(), str),
	};
}

function assertPid(child: ChildProcess): number {
	if (child?.pid == null) throw new Error('Child process failed to spawn');
	return child.pid;
}

export interface Options {
	spawn: () => ChildProcessByStdio<Writable | null, Readable, Readable | null>;
	isStartedPatterns: ReadonlyArray<RegExp>;
	logger?: typeof createLogger;
	name?: string;
	startTimeout: number;
	stopTimeout: number;
}

export default function create(opts: Options): Manager {
	const { spawn, isStartedPatterns, logger, name = 'ChildProcess', startTimeout, stopTimeout } = opts;
	const { dispatch, getState } = createReducer({
		state: { phase: Phase.Stopped },
		reducer(state: InternalState, action: StartAction | StopAction | CompleteAction | FailAction): InternalState {
			switch (action.type) {
				case ActionType.Start:
					return reduceStartAction(state, action);
				case ActionType.Stop:
					return reduceStopAction(state, action);
				case ActionType.Complete:
					return reduceCompleteAction(state, action);
				case ActionType.Fail:
					return reduceFailAction(state, action);
				// no default
			}
		},
	});
	const log = (logger ?? createLogger)(getState, name);

	function reduceStartAction(state: InternalState, action: StartAction): InternalState {
		switch (state.phase) {
			case Phase.Stopped:
			case Phase.Stopping: {
				log.info(`will ${action.type}`);
				const child = spawn();
				const pid = assertPid(child);
				const promise = new Promise<number>(function (resolve, reject) {
					function dataListener(chunk: any) {
						if (isStartedTest(chunk)) {
							finish({ type: ActionType.Complete, action });
							resolve(pid);
						}
					}
					function closeListener() {
						const fail = { type: ActionType.Fail, action, reason: FailType.Close } as const;
						finish(fail);
						reject(errorForFail(fail));
					}
					function timeout() {
						const fail = { type: ActionType.Fail, action, reason: FailType.Timeout } as const;
						finish(fail);
						child.kill();
						reject(errorForFail(fail));
					}
					function finish(action: CompleteAction | FailAction) {
						clearTimeout(timer);
						child.off('close', closeListener);
						child.stdout.off('data', dataListener);
						dispatch(action);
					}
					const timer = setTimeout(timeout, action.timeout);
					const isStartedTest = createIsStartedTest(isStartedPatterns);
					child.once('close', closeListener);
					child.stdout.on('data', dataListener);
				});
				return { phase: Phase.Starting, pid, child, pending: { action, promise } };
			}
			default:
				log.info(`already ${state.phase}`);
				return state;
		}
	}

	function reduceStopAction(state: InternalState, action: StopAction): InternalState {
		switch (state.phase) {
			case Phase.Started:
			case Phase.Starting: {
				log.info(`will ${action.type}`);
				const { pid, child } = state;
				const promise = new Promise<number>(function (resolve, reject) {
					function closeListener() {
						finish({ type: ActionType.Complete, action });
						resolve(pid);
					}
					function timeout() {
						const fail = { type: ActionType.Fail, action, reason: FailType.Timeout } as const;
						finish(fail);
						reject(errorForFail(fail));
					}
					function finish(action: CompleteAction | FailAction) {
						clearTimeout(timer);
						child.off('close', closeListener);
						dispatch(action);
					}
					const timer = setTimeout(timeout, action.timeout);
					child.once('close', closeListener);
					child.kill();
				});
				return { phase: Phase.Stopping, pid, child, pending: { action, promise } };
			}
			default:
				log.info(`already ${state.phase}`);
				return state;
		}
	}

	function reduceCompleteAction(state: InternalState, complete: CompleteAction): InternalState {
		const { type: verb } = complete.action;
		switch (state.phase) {
			case Phase.Starting:
			case Phase.Stopping:
				if (state.pending.action === complete.action) {
					log.info(`${verb} did complete`);
					return verb === ActionType.Start
						? { phase: Phase.Started, pid: state.pid, child: state.child }
						: { phase: Phase.Stopped };
				}
				break;
			// no default
		}
		log.warn(`${verb} did cancel (already ${state.phase})`);
		return state;
	}

	function reduceFailAction(state: InternalState, fail: FailAction): InternalState {
		const { type: verb } = fail.action;
		switch (state.phase) {
			case Phase.Starting:
			case Phase.Stopping:
				if (state.pending.action === fail.action) {
					log.error(`${verb} failed (reason: ${fail.reason})`);
					return verb === ActionType.Start
						? { phase: Phase.Stopped }
						: { phase: Phase.Started, pid: state.pid, child: state.child };
				}
				break;
			// no default
		}
		log.warn(`${verb} did cancel (reason: ${fail.reason})`);
		return state;
	}

	function assertPromise(phase: Phase.Starting | Phase.Stopping) {
		const state = getState();
		if (state.phase !== phase) {
			throw new Error(`Unexpected phase ${state.phase}, expected ${phase}`);
		}
		return state.pending.promise;
	}

	return {
		getState,
		start: async (timeout = startTimeout) => {
			const state = getState();
			switch (state.phase) {
				case Phase.Started:
					log.info(`already ${state.phase}`);
					return state.pid;
				default:
					dispatch({ type: ActionType.Start, timeout });
					return assertPromise(Phase.Starting);
			}
		},
		stop: async (timeout = stopTimeout) => {
			const state = getState();
			switch (state.phase) {
				case Phase.Stopped:
					log.info(`already ${state.phase}`);
					return;
				default:
					dispatch({ type: ActionType.Stop, timeout });
					return assertPromise(Phase.Stopping);
			}
		},
	};
}
