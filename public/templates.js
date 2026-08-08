// The 6 outreach templates. {naam}, {views}, {months} are placeholders.
const TEMPLATES = {
  geen_unieke_kennis: {
    label: '1. Not sharing unique knowledge',
    text: ({ naam }) =>
      `Hey ${naam}, just wanted to say I think you've got a lot of unique knowledge as a fitness coach, but unfortunately I don't really see that reflected in your feed yet. Which is a shame, because that's exactly where you'd get most of your clients from. Want to check out this 14-second video?`
  },
  vastzit_onder_x: {
    label: '2. Stuck under X views',
    text: ({ naam, views }) =>
      `Hey ${naam}, I was just looking through your profile and noticed you're still stuck under ${views} views. Which is a shame because I think you've got a great story to tell. I see it come up so often - want to check out this video? It's only 14 seconds long.`
  },
  inconsistent_waarde: {
    label: '3. Inconsistent value content',
    text: ({ naam }) =>
      `Hey ${naam}, just wanted to say you've got a great story to tell. What did stand out to me is that you have a lot of unique value to offer, but it's not quite coming across on your page yet (probably because scripting and editing simply takes up too much time right now). Maybe I can help you out — want to check out this video? It's only 14 seconds long.`
  },
  inconsistent_posten: {
    label: '4. Posting inconsistently',
    text: ({ naam }) =>
      `Hey ${naam}, wanted to say you're posting really great content and sharing genuine value as a fitness coach, but I did notice the posting is a bit inconsistent right now. Totally understandable too, since spending hours every week researching and editing on top of your ongoing coaching is nearly impossible. Still, it's a shame, because those gaps in your schedule are simply costing you a bunch of clients. I might have a solution for this — want to check out this 14-second video?`
  },
  lang_geen_content: {
    label: '5. No content in a while',
    text: ({ naam, months }) =>
      `Hey ${naam}, I noticed you haven't posted any content in a while — the last time was even ${months} months ago. It probably took up a lot of your time to make content, or you weren't sure what to do and found it hard to come up with ideas. Which is a shame because I think you've got a great story to tell. If you're ever interested in picking content creation back up a bit, would you check out this video? It's only 14 seconds long.`
  },
  veel_tijd_content: {
    label: '6. Spending a lot of time on content',
    text: ({ naam }) =>
      `Hey ${naam}, really great content you're posting, and I think you've got a great story to tell. It's just that you might be spending quite a lot of time on content planning, researching, scripting and editing. If that's the case, my only ask is that you check out this video, it's only 14 seconds long.`
  }
};

// Rule-based suggestion. Stats-based cases (5, 4, 2) are fairly reliable;
// cases 1, 3, 6 depend on subjective content-quality judgment the tool can't
// see, so they're best-guess defaults — always double-check before sending.
function suggestTemplate({ lastPostWeeks, postsPerWeek, avgViews, viewsThreshold }) {
  const lw = Number(lastPostWeeks);
  const ppw = Number(postsPerWeek);
  const views = avgViews === '' || avgViews === null || avgViews === undefined ? null : Number(avgViews);

  if (!isNaN(lw) && lw >= 8) {
    const months = Math.max(1, Math.round(lw / 4.345));
    return { key: 'lang_geen_content', months, reason: `Last post was ${lw} weeks (~${months} mo) ago.` };
  }
  if (!isNaN(ppw) && ppw > 0 && ppw < 1) {
    return { key: 'inconsistent_posten', reason: `Posting frequency is low (${ppw}x per week) with probable gaps.` };
  }
  if (views !== null && viewsThreshold && views < viewsThreshold) {
    return { key: 'vastzit_onder_x', reason: `Average views (${views}) is below your threshold of ${viewsThreshold}.` };
  }
  if (!isNaN(ppw) && ppw >= 1 && ppw < 3) {
    return { key: 'inconsistent_waarde', reason: `Posting frequency (${ppw}x/week) is decent but not very consistent.` };
  }
  if (!isNaN(ppw) && ppw >= 3) {
    return { key: 'veel_tijd_content', reason: `Posts often (${ppw}x/week) — probably takes up a lot of time. Check yourself whether template 1 fits better.` };
  }
  return { key: 'geen_unieke_kennis', reason: 'No clear statistical signal — default suggestion, use your own judgment.' };
}
