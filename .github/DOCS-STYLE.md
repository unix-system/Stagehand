# Documentation language

Use ASD-STE100 Issue 9 as the language reference:
https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf

Apply these rules to site pages, navigation text, and generated reference descriptions:

- Use direct statements. Remove idioms, metaphors, slogans, and promotional claims.
- Use a maximum of 20 words for instructions and 25 words for descriptions. Prefer 20 words for both.
- Put one instruction in each sentence. Use numbered steps when order matters.
- Use the active voice. Identify the component that performs an action.
- Use the same technical term for the same object or operation.
- Preserve API names, property names, UI labels, units, limits, and executable examples.
- Use American English spelling in prose. Preserve spelling in identifiers and UI labels.
- Explain a technical term when a new user needs its meaning.
- Use full forms instead of contractions.
- Check the standard's approved vocabulary and meanings during review. Short sentences alone do not establish compliance.

## Local check

Run `pnpm docs:language`. This generates the reference and checks selected vocabulary and grammar uses, plus sentence length.
Vocabulary and grammar findings fail the check. The rules target errors found during the manual review.
They distinguish some noun and verb uses, such as "the display" and "the report displays".
They also check selected complex tenses, action phrases with "-ing", contractions, and repeated words.
These patterns are regression checks. They are not a full dictionary, part-of-speech parser, or STE validator.
The check requires at least 75% of prose units on each page to contain no more than 20 words.
It includes prose sentences, table cells, and visible homepage frontmatter.
It excludes headings, code blocks, and raw schemas. It counts each inline code expression as one technical unit.
This is a sentence-length measure, not a percentage of ASD-STE100 compliance.

Read the remaining long sentences with `node tools/docs-language.mjs --details`.
Review other grammar, word meanings, and technical accuracy manually.
See [the vocabulary and grammar review](STE-REVIEW.md) for scope, examples, and technical terms.
Run `pnpm docs:test` after changes to the checks or reference generator.

## Generated reference

The catalog remains the source for API definitions and complete parameter schemas.
Site-only wording is in `docs/.vitepress/catalog-language.json`.
Each replacement records its source text. The build fails if that text changes, so an editor must review the replacement.
Parameter descriptions have the same source checks, including checks for removed parameters.
Do not edit generated pages under `docs/reference/`.
