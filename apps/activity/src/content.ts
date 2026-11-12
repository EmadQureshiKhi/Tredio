import type { Rng, Side, TrendView } from "./plan";

const pick = <T>(xs: readonly T[], rng: Rng): T => xs[Math.floor(rng() * xs.length)]!;
const pts = (n: number) => n.toFixed(1);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

/** Fills {name}, {index}, {change} and {when} in a template. */
function fill(template: string, t: TrendView, when = ""): string {
  return template.replaceAll("{name}", t.displayName).replaceAll("{index}", pts(t.index)).replaceAll("{change}", pct(t.change24h)).replaceAll("{when}", when);
}

const UP_NOTES = [
  "{name} at {index} and still climbing. Readers keep coming in, so I expect it to hold above here {when}.",
  "Coverage on {name} is broadening, not fading. Up {when}.",
  "{change} on the day and the sources agree. Staying with the move on {name}.",
  "Second wave on {name} looks likely. More posts than yesterday at this hour.",
  "Quiet start, but {name} keeps picking up mentions. Calling it higher {when}.",
  "Index {index}. Wikipedia and Bluesky both rising for {name}, that usually leads.",
];
const DOWN_NOTES = [
  "{name} looks tired at {index}. The story is a day old and replies are thinning out.",
  "Peak attention is behind {name} I think. Lower {when}.",
  "{change} already and nothing new to say about {name}. Fading it.",
  "News cycle is moving on from {name}. I expect it to drift down {when}.",
  "Mentions for {name} are mostly reposts now. That is usually the top.",
  "Too much hype priced into {name} at {index}. Calling a cool-off.",
];
const POSTS = [
  "Index check on {name}: {index} now, {change} over the day.",
  "Watching {name} closely today. The move at {index} feels early.",
  "Anyone else trading {name}? Volume looks thin for how much people are posting.",
  "Took some profit on {name}, keeping a small position.",
  "{name} keeps surprising me. {change} on the day.",
  "Sources for {name} are split: news up, social flat. Waiting for one to break.",
  "Added a little to {name} at {index}.",
  "Rotation out of {name} has not started yet, as far as I can see.",
];
const AGREE = [
  "Agree with @{handle} here. The readers are still arriving for {name}.",
  "Same read as @{handle}. Took a small position the same way.",
  "@{handle} called this well, {name} is behaving exactly like that.",
];
const DISAGREE = [
  "Respectfully, @{handle}, I see it the other way. {name} at {index} looks stretched.",
  "Not sure about this one @{handle}. The sources are cooling on {name}.",
  "I am on the other side of @{handle} on {name}. We will see who is right.",
];

/** A call note under 280 characters. */
export function callNote(t: TrendView, direction: Side, horizonSec: number, rng: Rng): string {
  const when = horizonSec >= 604_800 ? "this week" : "by tomorrow";
  return fill(pick(direction === "up" ? UP_NOTES : DOWN_NOTES, rng), t, when).slice(0, 280);
}

/** A thread post under 500 characters; an answer to another caller agrees or disagrees with their call. */
export function postBody(t: TrendView, rng: Rng, reply?: { handle: string; agree: boolean }): string {
  const template = reply ? pick(reply.agree ? AGREE : DISAGREE, rng).replaceAll("{handle}", reply.handle) : pick(POSTS, rng);
  return fill(template, t).slice(0, 500);
}
