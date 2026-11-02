# Ahab — plain-language product summary

Updated: 3 November 2026. This document is intended to be shared with another chat, collaborator or potential adviser. It describes the current product and the founder's direction without explaining the technology behind it. APP.md remains the more detailed implementation reference.

Live app: https://ahab.pendia-community.workers.dev

## What Ahab is

Ahab is an AI-assisted video studio for creators, independent founders, small businesses and people who want to make professional promotional content without arranging a full video shoot.

Users bring an idea, a brief and, when needed, a portrait or product image. Ahab helps prepare the words and visual direction, asks the user to approve them, and generates a downloadable vertical video. People choose the kind of video they want rather than choosing an AI model.

The product's promise is accessible video creation with a clear price and a guided process. It does not promise that every generated video will look like real customer footage, reproduce a product perfectly or improve advertising results.

## Who it is for

- Founders and independent developers introducing an app, service or business.
- Small sellers and businesses presenting products or testing different messages.
- Creators making presenter videos, explainers, scripted scenes or promotional content.
- Individuals who want to use an authorized portrait and their own words without filming every take themselves.

These are intended audiences, not a claim that customer demand or repeat purchases have already been validated. The founder has a very limited initial budget and wants to keep the service affordable while covering the full cost of delivering each purchase.

## The six video formats

| Format | What the user is trying to make | Selectable length |
| --- | --- | --- |
| Talking presenter | A person speaking to camera: an introduction, pitch, founder story or personal message. | 5–120 seconds |
| Demo / tutorial | A generated scene illustrating how a product or idea works. Exact product actions are not guaranteed. | 5–25 seconds |
| Unboxing | A scripted scene introducing a package and its contents. | 5–25 seconds |
| Scripted reaction | A performed discovery, surprise or response, rather than a real customer's testimonial. | 5–25 seconds |
| Showcase / lifestyle | Product details, atmosphere or an everyday setting featuring the subject. | 10–25 seconds |
| Explainer | A person explaining something, or a visual demonstration, problem-and-solution story or feature comparison. | 5–100 seconds with a presenter; visual scenes up to 30 seconds |

Videos offer 720p or 1080p, with 1080p selected by default. Speech timing and the final result can vary.

Demo, unboxing, reaction, showcase and short visual explainers offer Standard and Plus generation. Talking presenters and longer explainers use the presenter option. Plus is an alternative generation option; it is not a guarantee of a better-looking result.

## How someone uses it

1. Explore the app and choose a video format, length, resolution and quantity. Different selections can be combined in one purchase.
2. Review the exact total before payment. A visitor can check a price before creating an account; an account is required to buy.
3. Make a one-time purchase. This adds video allowances to the account and does not start generating anything.
4. Open the studio when ready, choose a suitable allowance, and prepare the brief, references and any dialogue.
5. Use the included writing assistance to keep the dialogue as written, polish it or draft it from supplied facts. Review the prepared words and direction before continuing.
6. Optionally edit a character portrait using the edit included with that video. A suitable uploaded image can also be used directly.
7. Approve the script and references, then generate the video. The finished result appears in the private library for review and download.

A user can explore the studio before buying. Paid preparation and generation require a suitable allowance. Changing an approved brief or its settings requires preparing it again before generation.

## What users provide

**Brief and dialogue.** The user explains what the video should show and the facts it may use. Presenter videos need words to speak or supplied narration. A visual scene can have no spoken dialogue. Writing preparation is required before generating a video, including when the user chooses to keep their exact wording.

**Character portraits.** Users upload images they have permission to use. Uploading an image does not automatically change it. Portrait editing happens only when explicitly requested, can use up to 14 selected character references, and produces one edited portrait per successful included edit. Product images are kept separate and are not sent to the portrait editor. Editing someone's appearance does not itself establish permission to use their likeness.

**The image to animate.** Each video uses one explicitly selected reference image where applicable. If the scene needs to show both a person and a product, the user supplies an image already containing both. Separate portrait and product uploads are not automatically combined. Presenter videos require a suitable portrait. Demo, unboxing and showcase videos require a product or scene image. Scripted reactions and visual explainers can start from text without an image.

**Voice.** Presenter users can choose an available AI voice or upload their own MP3/WAV narration. The current live voice list contains Sara · English. Uploaded narration is checked for duration and must fit the chosen video; the overall audio storage limit is 121 seconds. Optional presenter captions are available. Visual scenes use generated sound and any approved dialogue.

**Existing videos.** Forwarding uploaded video or audio as a reference for visual-scene generation is currently unavailable. Ahab should not be described as a tool that precisely edits or copies an uploaded UGC video.

## What a purchase includes

An allowance is permission to make one video, with the purchased generation option, resolution and duration capacity. A suitable allowance can be used for a shorter video.

**One allowance creates one video. Choosing a shorter video still consumes that allowance. The remaining seconds do not become a balance for another video.**

Each video allowance includes:

- One video generation.
- Up to three writing preparations.
- One optional successful character-portrait edit.

Unused allowances do not expire and can be used separately. Buying several does not mean generating all of them at once. A successful portrait edit remains available if the video generation fails. There is no separate image-edit purchase or extra render fee.

## Current pricing

Prices are calculated in USD from the selected length and generation option.

| Generation option | One allowance in a selection | Two or more allowances in that selection |
| --- | ---: | ---: |
| Presenter | $0.0959 per second | $0.095 per second |
| Standard visual scene | $0.2729 per second | $0.272 per second |
| Plus visual scene | $0.3709 per second | $0.370 per second |

Each selection's own quantity determines its rate. For example, a quantity-two presenter selection gets the multiple-purchase rate, while a separate quantity-one reaction selection still uses its single rate.

Calculate every selection, add the whole purchase together, then round the final combined total down once to whole US dollars. A $15.90 purchase becomes $15. Individual videos are not separately rounded down to whole dollars. A selection of one 30-second presenter video calculates to $2.877 and, if purchased alone, is charged as $2.

A purchase that would round to $0 cannot proceed; the user needs a larger quantity or longer selection. The app does not silently raise the price to a minimum charge.

## Payment, failures and purchase history

There is no subscription. Checkout supports eligible payment methods, including USDC where available. Allowances appear only after payment is verified.

Abandoned unpaid checkouts are actively closed after nine minutes, with checks every minute and when purchase history refreshes. Payment-service interruptions can delay this. A payment already submitted and processing is shown separately and is not treated as abandoned. An unpaid checkout does not prevent another purchase.

Purchase history distinguishes awaiting payment, processing, paid, expired and failed payments.

The policy is no voluntary cash refunds, subject to applicable mandatory rights. A confirmed technical generation failure restores the affected allowance. Disliking a technically successful creative result does not automatically qualify as a technical failure. Uncertain payment or generation outcomes are checked before retrying, to reduce duplicate charges or duplicate use of an allowance.

## Accounts and the private library

Users sign in with a username and password. They can set an optional eight-character recovery passcode. Without a recovery passcode, signed-out account recovery is unavailable. Sign-in can last up to 270 days. Signed-in users see account-aware navigation and are redirected away from sign-in and signup pages.

The library keeps:

| Item | Storage allowance |
| --- | --- |
| Manually saved prompts | Latest 80 |
| Uploaded and prepared images | Latest 40 |
| Uploaded audio | Latest 20 |
| Video references | Latest 10 |
| Generated videos | Latest 23; also deleted after 121 days |

Adding an item beyond its storage limit removes the oldest item in that category. Users should download finished work they want to keep. Deleting an output does not remove the purchase receipt or unused allowances.

## Current limits to describe honestly

- Ahab generates videos; it does not guarantee advertising performance, exact product handling or perfectly realistic reactions.
- The portrait tool currently edits uploaded character references. Creating a new portrait from text alone is not offered.
- Multiple uploaded images are not automatically merged into a scene.
- There is no separate music generator, music mixer or voice-cloning feature.
- A suggested shot plan can guide a generated scene. It does not mean Ahab separately generates and assembles presenter footage, product cutaways, narration and music into a finished edited campaign.
- A complete multi-scene animated ad, such as the umbrella story discussed with the founder, is not an established automatic workflow in the current app.
- Publicly available checkout and generation controls, automated checks and a working interface do not by themselves prove every paid payment method or generation scenario has been successfully tested in real use.

## Business direction and open questions

The founder wants professional video creation to be accessible to people with small budgets, using one-time purchases and allowances that can be used later. Customers should be able to understand the deliverable and price without learning the underlying AI tools.

Current priorities include getting representative finished examples, acquiring initial customers, learning which formats they actually use, and checking whether those customers return. A finished-video example and a recording of the app's workflow serve different purposes: the example demonstrates output quality, while the walkthrough demonstrates the process.

Recent ideas include older fictional characters, distinctive recurring brand personalities, and animated product stories. These are creative possibilities to test, not proof of customer demand or promised features. The app should not assume that an older character automatically creates trust, that all older viewers accept AI ads, or that all younger viewers reject them.

The latest agreed experience does not recommend a duration for the user, push them toward the longest allowance, or add a special pre-checkout prompt telling them to use an existing allowance. It does clearly explain that making a shorter video consumes one allowance.

## Context for another chat

Use this document as the current plain-language product brief, and APP.md or the current app for implementation details. Distinguish what exists from ideas being explored. Do not assume music mixing, automatic multi-clip editing, text-only portrait creation, uploaded-video recreation or proven ad results are already available. Suggestions should respect the founder's small budget and account for writing, optional portrait editing, video generation and payment costs together.
