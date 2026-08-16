# CardMirror Feature Installer
This is an **unofficial** and **third-party** feature installer for CardMirror. I'm not affiliated with or endorsed by the CardMirror developers. If you don't have CardMirror already, you should install it separately. This patcher adds several additions that may be helpful for debaters.

This is an ongoing project, so more plugins will come out!

Email me at `blueabstractionoop@gmail.com` for any comments, issues, or more features you want to see added!

## Installation
You can watch my video for installing these plugins, or follow the text instructions below.

[![Watch the video.](https://img.youtube.com/vi/mBk_caQd4cs/0.jpg)](https://www.youtube.com/watch?v=mBk_caQd4cs)

Go to the latest release in [releases](https://github.com/Blue-Abstraction/cardmirror-plugins/releases) for this repository to find the files you need to download.
Before installation, make sure your CardMirror is not running.
### Windows
1. Download the .exe file.
2. Run the .exe file. If Windows blocks it, simply press `More Info` and `Run Anyway`.
3. In the window that pops up, select the location of CardMirror's _installation file_ (if it's not automatically found). To find the installation file, right-click the CardMirror application and select `Open File Location`. Copy the file location and paste it into the installer.
4. Select the features you want installed and press `Install Selected`.
5. Run CardMirror normally.

### Mac
1. Download the .zip file and extract it.
2. Run the .app file. If your Mac blocks it, go to System Settings > Privacy and Security. Scroll all the way down and press `Open Anyway`. Then, verify yourself.
3. In the window that pops up, select the location of your CardMirror _app_ (if it's not automatically found). Your CardMirror should be in `Applications`.
4. Select the features you want installed and press `Install Selected`.
5. Run CardMirror normally.

### And you're done!

## Plugin Features
### Round Report Creator
This plugin allows you to create round reports much easier. 

Once installed, you will find buttons for different speech names (1AC, 1NC, 2AC...). Once you receive a document, you can click the associated button depending which speech it is.

At the end of the round, you should have many different speech documents selected. Press `RR` to open up a form where you can input the information of the round, including the tournament name and number, teams, judges, affirmative name, 1NC off, and the 2NR position(s). 

Once you're finished filling out information, press `OK` and save your Round Report on your computer.

I made this feature because I found it inconvenient creating a copy of a Round Report template over and over again and then having to go back to find certain documents... This plugin makes the process much quicker!

### Keyword Finder
Do you hate certain authors or offensive language? Do you want to punish your opponents for using them? This plugin allows you to save a list of keywords and search a document for those names or words! 

Simply press the `Keyword Finder` button and create a list of keywords you want detected when you press `Scan Document`. You can also import them from a `.txt` file or export them. These keywords are saved locally, so even if you close out of CardMirror, they will be saved.

Press `Delete Keywords` if you want the comments for keywords to be removed from the document.

I also have a [version of this](https://github.com/Blue-Abstraction/DebateKeywordFinder) for Word that I created before if you want to check it out. Though, it's not as great due to the limitations Word has.

### Smart Doc
Smart Doc is a plugin that creates speech docs with an auto-generated pocket and consistent file naming ([Tournament] [Round #]---[Speech Name] vs. [Opponent Team]). Just click `Smart Doc` to reveal a menu where you select the speech the doc is for.

This is achieved through Round Context: a form you fill out with information about the tournament/round you're in. Round Context also works with the Round Report Creator by auto-filling repetitive parts.

### Collapsible Headers
It's just what the plugin sounds like! You can collapse pockets, hats, and blocks by pressing the triangle to the left of each style. This makes viewing documents much quicker and efficient.

For those who don't know what "collapsing" is, it simply hides the content underneath the style without actually deleting it.

### Gendered Pronoun Review
This plugin identifies and suggests gender neutral alternatives to gendered pronouns.

This could be useful for debaters cutting lots of cards which use generic masculine language like "he," "him," or "his." It's especially prevalent in older texts, 
and it's common for debaters to strike-through these pronouns and replace them with gender neutral ones in brackets.

By clicking a button, the plugin will search the current card you're in or the highlighted selection of your cursor and allow the user to accept or deny gender neutral alternatives. At the end, the program fixes all of language the user accepted automatically.

For subject-verb agreements, the plugin will only detect common ones, like "is" -> "are" and "has" -> "have." Other verbs, however, must be changed by the user manually. For example, the sentence "He runs to the house" would be changed to "~~He~~ [They] runs to the house,"
which is incorrect. This plugin will supply comments at parts where you need to manually change the verbs.

If this plugin becomes more popular or somebody wants all verbs to be fixed automatically, a local parser could be added. But, for now, that's not something I'm working towards.
