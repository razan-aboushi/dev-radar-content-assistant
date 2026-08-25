# Your writing corpus

Drop your own published posts in this folder as `.md` or `.txt` files — one post
per file. Then run:

```bash
npm run style:learn
```

That reads every file here and measures **statistics only**: average sentence
length, paragraph shape, how often you ask questions, how often you write in the
first person, and your emoji rate. Those numbers are written into
`style/style-profile.json` under `measured`, and are given to the model as
guidance.

Two things worth being clear about:

- **Nothing from these files is ever copied into a draft.** Only the derived
  numbers are stored. Your posts are not sent anywhere and are not used as
  text to remix.
- **There is no LinkedIn scraper here, deliberately.** LinkedIn blocks automated
  access and scraping it risks your account. Copy and paste is slower for ten
  minutes and cannot get you banned.

Ten to fifteen posts is plenty. Fewer than three and the numbers are too noisy
to be useful, so `style:learn` will tell you so rather than pretend.

This folder is gitignored apart from this README.
