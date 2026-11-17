import sys, wf1_intake, wf2_delivery, wf3_intent, wf4_scorer, wf5_cadence, wf6_nurture
out = sys.argv[1]
for mod, fname in [(wf1_intake, "1_Caricature_Prospect_Intake.json"), (wf2_delivery, "2_Caricature_Delivery_Tracker.json"),
                   (wf3_intent, "3_Caricature_Intent_Ingestor.json"), (wf4_scorer, "4_Caricature_Intent_Scorer.json"),
                   (wf5_cadence, "5_Caricature_Cadence_Runner.json"), (wf6_nurture, "6_Caricature_Nurture_Drafts.json")]:
    print(fname, mod.build(f"{out}/{fname}"), "nodes")
