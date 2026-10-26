import assert from "node:assert/strict";
import { deckSlideCss, designSlides, isDesignDeck, setDesignSlideNotes } from "../../src/shared/design-deck";
import { sanitizeDesignHtml } from "../../src/shared/design-html";

// Decks: slides are the deck element's direct children; notes edit in place.
const deck = sanitizeDesignHtml(`<!doctype html><html><head></head><body><main data-aegis-deck>
<section data-aegis-slide data-aegis-notes="Open strong"><h1>Q3 review</h1><p>Revenue up</p></section>
<section data-aegis-slide><p>No heading here</p></section>
<section data-aegis-slide></section>
<div>not a slide</div>
</main></body></html>`);
assert.ok(isDesignDeck(deck));
assert.ok(!isDesignDeck("<main><section>x</section></main>"));
const slides = designSlides(deck);
assert.deepEqual(slides.map((s) => [s.index, s.title, s.notes]), [[0, "Q3 review", "Open strong"], [1, "No heading here", ""], [2, "Slide 3", ""]]);
assert.ok(slides.every((s) => s.id), "slides are layers with ids");
const noted = setDesignSlideNotes(deck, slides[1].id, "Pause here.\nThen the chart.");
assert.equal(designSlides(noted)[1].notes, "Pause here.\nThen the chart.");
assert.equal(designSlides(setDesignSlideNotes(noted, slides[0].id, "  "))[0].notes, "", "empty notes are removed");
assert.throws(() => setDesignSlideNotes(deck, "nope", "x"), /no longer exists/);
assert.equal(deckSlideCss(2), "[data-aegis-deck]>[data-aegis-slide]:not(:nth-child(3 of [data-aegis-slide])){display:none!important}");
console.log("design-deck: deck detection, slides and titles, notes editing and slide CSS passed");
