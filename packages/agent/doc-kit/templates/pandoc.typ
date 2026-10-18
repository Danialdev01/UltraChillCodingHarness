#import "/.ucch/doc-cache/templates/base.typ": conf, callout, horizontalrule

$if(smart)$
$else$
#set smartquote(enabled: false)
$endif$
$for(header-includes)$
$header-includes$
$endfor$

#show: doc => conf(
  doctype: "$if(type)$$type$$else$report$endif$",
$if(title)$
  title: [$title$],
$endif$
$if(subtitle)$
  subtitle: [$subtitle$],
$endif$
  authors: ($for(author)$[$author$],$endfor$),
$if(date)$
  date: [$date$],
$endif$
$if(version)$
  version: [$version$],
$endif$
$if(status)$
  status: [$status$],
$endif$
$if(abstract)$
  abstract: [$abstract$],
$endif$
$if(toc-off)$
  toc: false,
$elseif(toc)$
  toc: true,
$endif$
$if(lang)$
  lang: "$lang$",
$endif$
$if(papersize)$
  paper: "$papersize$",
$endif$
  doc,
)

$body$

$if(citations)$
$if(csl)$
#set bibliography(style: "$csl$")
$elseif(bibliographystyle)$
#set bibliography(style: "$bibliographystyle$")
$endif$
$if(bibliography)$
#bibliography($for(bibliography)$"$bibliography$"$sep$,$endfor$)
$endif$
$endif$
